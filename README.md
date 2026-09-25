# justwork proxy
OpenAI to Anthropic translator for the JustWorker gateway.
Background: api.justwoker.icu blocks POST /v1/chat/completions with Cloudflare 403, while POST /v1/messages works. OpenCode and Zed speak OpenAI format, so this proxy translates requests upstream and converts responses back.
Handles text chat, system prompts, base64 images, function tools, streaming SSE and plain JSON, plus legacy POST /v1/completions for Zed edit predictions.
Files: server.js has zero dependencies, package.json, render.yaml for Render Blueprint, Dockerfile for the registry route, deploy.js for API deploys.
## Push to GitHub
```
git init
git add server.js package.json render.yaml Dockerfile README.md deploy.js .gitignore
git commit -m "justwork proxy"
git remote add origin https://github.com/YOU/justwork.git
git push -u origin main
```
## Deploy option A, Render API from this folder
```
node deploy.js --dry-run
node deploy.js --allow-no-key
```
Env: RENDER_API_KEY for the Render account, JUSTWOKER_API_KEY optional when allow-no-key is used, PROXY_AUTH_TOKEN optional and auto generated when missing. The repo URL is read from the git remote, so push first. The script skips creation when the service exists, waits for /health unless --no-wait is passed, and prints the OpenCode provider block with the live URL. Use --update to refresh env vars later.
## Deploy option B, Render Blueprint dashboard
Render dashboard, New, Blueprint, select the justwork repo. Set JUSTWOKER_API_KEY and PROXY_AUTH_TOKEN in the service Environment tab. Free plan sleeps when idle, first request after idle is slow.
## OpenCode config, cloud mode
```
"justdowork": {
  "name": "Justworker",
  "npm": "@ai-sdk/openai-compatible",
  "options": {
    "baseURL": "https://kelmah-jdw-proxy.onrender.com/v1",
    "apiKey": "{env:JDW_PROXY_TOKEN}"
  },
  "models": {
    "gpt-5.6-terra": {
      "name": "gpt-5.6-terra",
      "modalities": { "input": ["text", "image"], "output": ["text"] },
      "attachment": true,
      "limit": { "context": 1050000, "output": 128000 }
    },
    "gpt-5.6-luna": {
      "name": "gpt-5.6-luna",
      "modalities": { "input": ["text", "image"], "output": ["text"] },
      "attachment": true,
      "limit": { "context": 1050000, "output": 128000 }
    },
    "gpt-5.6-sol": {
      "name": "gpt-5.6-sol",
      "modalities": { "input": ["text", "image"], "output": ["text"] },
      "attachment": true,
      "limit": { "context": 1050000, "output": 128000 }
    }
  }
}
```
Replace the baseURL host with the real Render URL. Set local env JDW_PROXY_TOKEN to the same value as server PROXY_AUTH_TOKEN, then restart OpenCode.
## Local mode
```
node server.js
```
With key: set JUSTWOKER_API_KEY in the environment first. Base URL is http://localhost:18923/v1.
## Security
A public URL with no token lets anyone burn JustWorker credits. Always set PROXY_AUTH_TOKEN on cloud and keep JUSTWOKER_API_KEY server side only.
