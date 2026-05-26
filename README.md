# Snipe and Cloak: Cloudflare integration v1

This patch makes the local website communicate with two services:

- FastAPI backend on `http://localhost:8000` for routes, stops, geocoding, and initial planning.
- Cloudflare Worker/Durable Object on `http://localhost:8787` for autonomous Mei sessions.

## Files to copy

```powershell
copy frontend-src\App.jsx "C:\Users\ganes\Desktop\3D Objects\Cloaker\frontend\src\App.jsx"
copy frontend-src\App.css "C:\Users\ganes\Desktop\3D Objects\Cloaker\frontend\src\App.css"
```

Copy the worker folder into your project root:

```powershell
xcopy worker "C:\Users\ganes\Desktop\3D Objects\Cloaker\worker" /E /I /Y
```

## Backend terminal

```powershell
cd "C:\Users\ganes\Desktop\3D Objects\Cloaker\backend"
.\.venv\Scripts\activate
python -m uvicorn main:app --reload --port 8000
```

## Worker terminal

```powershell
cd "C:\Users\ganes\Desktop\3D Objects\Cloaker\worker"
npm install
copy .dev.vars.example .dev.vars
notepad .dev.vars
npm run dev
```

`.dev.vars` must contain:

```env
RIDERTS_API_KEY=your_riderts_key_here
```

Test:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

## Frontend terminal

```powershell
cd "C:\Users\ganes\Desktop\3D Objects\Cloaker\frontend"
notepad .env.local
npm install
npm run dev
```

`.env.local` should contain:

```env
VITE_API_BASE=http://localhost:8000
VITE_MEI_WORKER_URL=http://localhost:8787
```

## Communication test

1. Open `http://localhost:5173`.
2. Hatsu: select route(s).
3. En/Gyo/Ken: choose target stop and threshold.
4. Arm Mei.
5. The frontend calls `http://localhost:8787/api/mei/start`.
6. The page URL changes to `?mei=<session_id>`.
7. The Worker/Durable Object keeps polling via alarms.
8. The frontend reads `http://localhost:8787/api/mei/<session_id>`.
9. When the Durable Object logs one-stop-before, frontend switches to Kuro.

## Deploy later

- `frontend/` goes to Cloudflare Pages.
- `worker/` goes to Cloudflare Workers.
- Add `RIDERTS_API_KEY` as a Worker secret:

```powershell
npx wrangler secret put RIDERTS_API_KEY
```

- Set Pages env var:

```env
VITE_MEI_WORKER_URL=https://snipe-and-cloak-mei-worker.<your-subdomain>.workers.dev
```
