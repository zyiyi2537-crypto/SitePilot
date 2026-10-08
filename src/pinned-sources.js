import payloadWebsiteLock from "../sources/payload-website.lock.json" with { type: "json" };
import { PinnedSourceFetcher } from "./source-fetcher.js";

export const PINNED_SOURCES = Object.freeze({
  payloadWebsite: Object.freeze({
    repositoryId: payloadWebsiteLock.repositoryId,
    url: payloadWebsiteLock.repositoryUrl,
    templatePath: payloadWebsiteLock.path,
    commit: payloadWebsiteLock.commit,
    license: payloadWebsiteLock.expectedLicense,
    includePaths: payloadWebsiteLock.includePaths,
    fileManifestHash: payloadWebsiteLock.sourceTreeManifestHash,
    contentHash: payloadWebsiteLock.archiveHash,
  }),
});

export function createPinnedSourceFetcher(options = {}) {
  const repositories = Object.fromEntries(Object.values(PINNED_SOURCES).map((source) => [source.repositoryId, source]));
  return new PinnedSourceFetcher({ ...options, repositories });
}
