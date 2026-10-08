# SitePilot Deployment

Run from a checked-out SitePilot copy on the server:

```bash
sudo bash ops/install.sh
sudoedit /etc/sitepilot/sitepilot.env
sudo systemctl restart sitepilot
curl -fsS http://127.0.0.1:3100/health
```

Copy `nginx-sitepilot.conf` to `/etc/nginx/conf.d/sitepilot.conf`, replace the example hostname, run `nginx -t`, and reload Nginx. The example listens on localhost only; add a TLS vhost before public exposure.

This deploys only the SitePilot control plane. On a 2 GB-class server, keep builds and browser QA on a separately measured worker. Keep the CodeAtlas token only in `/etc/sitepilot/sitepilot.env`.

Set distinct random values of at least 32 characters for `SITEPILOT_API_TOKEN` and `SITEPILOT_REVIEW_TOKEN`, plus a server-owned `SITEPILOT_REVIEWER_ID`. The API rejects non-health requests until all three are present. Never place the reviewer token in the browser or Agent environment.
