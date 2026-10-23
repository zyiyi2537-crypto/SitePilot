import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { assertAgentRole, createArtifact, roleSystemPrompt } from "./agent-roles.js";
import { PolicyError } from "./core.js";

function baseUrlForPi(value) {
  let url;
  try { url = new URL(value); } catch { throw new PolicyError("Pi model URL must be a valid URL", "INVALID_INPUT"); }
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses)\/?$/, "").replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function textFromMessage(message) {
  return (message?.content || []).filter((part) => part?.type === "text").map((part) => part.text).join("").trim();
}

function parseJsonArtifact(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

export function createPiModelRuntime({ baseUrl, model, apiKey, apiMode = "chat_completions", timeoutMs = 60000 } = {}) {
  if (!baseUrl || !model || !apiKey) throw new PolicyError("Pi model URL, model and key are required", "CONFIG_REQUIRED");
  if (!["chat_completions", "codex_responses"].includes(apiMode)) throw new PolicyError("Unsupported Pi model API mode", "INVALID_INPUT");
  const providerId = "sitepilot-provider";
  const api = apiMode === "codex_responses" ? "openai-responses" : "openai-completions";
  const provider = createProvider({
    id: providerId,
    name: "SitePilot configured provider",
    baseUrl: baseUrlForPi(baseUrl),
    auth: {
      apiKey: {
        name: "SitePilot in-memory model key",
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: [{
      id: model,
      name: model,
      api,
      provider: providerId,
      baseUrl: baseUrlForPi(baseUrl),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }],
    api: api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const selectedModel = models.getModel(providerId, model);
  if (!selectedModel) throw new PolicyError("Pi model could not be registered", "CONFIG_ERROR");
  return Object.freeze({
    model: selectedModel,
    streamFn: (requestModel, context, options = {}) => models.streamSimple(requestModel, context, { ...options, timeoutMs }),
    complete: (context, options = {}) => models.completeSimple(selectedModel, context, { ...options, timeoutMs }),
  });
}

export class SitePilotAgentRuntime {
  constructor({ modelRuntime, toolRuntime = null, store = null, eventSink = null } = {}) {
    if (!modelRuntime?.model || typeof modelRuntime.streamFn !== "function") throw new PolicyError("Pi model runtime is required", "CONFIG_REQUIRED");
    this.modelRuntime = modelRuntime;
    this.toolRuntime = toolRuntime;
    this.store = store;
    this.eventSink = eventSink;
  }

  emit(event) {
    if (this.eventSink) this.eventSink(event);
    else this.store?.event?.(event.runId, event.type, { agentRunId: event.agentRunId, role: event.role, ...event });
  }

  async runRole({ role, runId, agentRunId, inputSnapshotId, prompt, tools = [], grant = { level: "L0" }, requestedScope = {}, artifactType, persistArtifact = true, maxTurns = 8, maxToolCalls = 8 } = {}) {
    assertAgentRole(role);
    if (!runId || !agentRunId || !inputSnapshotId || !prompt) throw new PolicyError("Agent run context and prompt are required", "INVALID_INPUT");
    const startedAt = new Date().toISOString();
    let turnCount = 0;
    let toolCallCount = 0;
    let finishRequested = false;
    this.emit({ type: "agent.started", runId, agentRunId, role, at: startedAt });
    const agent = new Agent({
      streamFn: this.modelRuntime.streamFn,
      initialState: {
        model: this.modelRuntime.model,
        systemPrompt: roleSystemPrompt(role),
        tools,
      },
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall, args }) => {
        if (++toolCallCount > maxToolCalls) return { block: true, reason: "Agent tool-call budget exhausted", terminate: true };
        const allowed = tools.some((tool) => tool.name === toolCall.name);
        if (!allowed) return { block: true, reason: `Tool ${toolCall.name} is not available to ${role}`, terminate: true };
        this.emit({ type: "agent.tool.requested", runId, agentRunId, role, tool: toolCall.name, at: new Date().toISOString() });
        if (role !== "Supervisor" && typeof args?.whyNow === "string" && typeof args?.expectedObservation === "string") {
          this.emit({
            type: "agent.decision",
            runId,
            agentRunId,
            role,
            action: toolCall.name,
            whyNow: args.whyNow,
            expectedObservation: args.expectedObservation,
            stopIf: Array.isArray(args.stopIf) ? args.stopIf : [],
            risk: args.risk || "medium",
            at: new Date().toISOString(),
          });
        }
        return undefined;
      },
      afterToolCall: async ({ toolCall, isError, result }) => {
        if (result?.terminate) finishRequested = true;
        this.emit({ type: "agent.tool.completed", runId, agentRunId, role, tool: toolCall.name, isError, at: new Date().toISOString() });
        return undefined;
      },
      finishTurn: () => {
        turnCount += 1;
        if (finishRequested || turnCount >= maxTurns) return { action: "end" };
        return undefined;
      },
    });
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "agent_end" || event.type === "turn_end") {
        this.emit({ type: `agent.${event.type}`, runId, agentRunId, role, at: new Date().toISOString() });
      }
    });
    try {
      await agent.prompt(prompt);
      const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
      const text = textFromMessage(assistant);
      const parsed = parseJsonArtifact(text);
      const artifact = parsed ? createArtifact({
        type: artifactType || parsed?.artifactType || (role === "Architect" ? "SiteStrategy" : role === "Supervisor" ? "SupervisorDecision" : "ComponentPlan"),
        role,
        runId,
        inputRefs: parsed?.inputRefs || [],
        output: parsed || { raw: text },
        status: parsed?.status || "complete",
        risk: parsed?.risk || (grant.level === "L2" ? "high" : "low"),
      }) : null;
      if (persistArtifact) {
        const persisted = artifact ? this.store?.recordArtifact?.(runId, artifact) || artifact : null;
        if (persisted) this.emit({ type: "agent.artifact.created", runId, agentRunId, role, artifactType: persisted.type, at: new Date().toISOString() });
        return { artifact: persisted, output: parsed, text, messages: agent.state.messages };
      }
      return { artifact: null, output: parsed, text, messages: agent.state.messages };
    } catch (error) {
      this.emit({ type: "agent.failed", runId, agentRunId, role, code: error.code || "AGENT_FAILED", at: new Date().toISOString() });
      throw error;
    } finally {
      unsubscribe();
    }
  }
}

export { parseJsonArtifact, textFromMessage };
