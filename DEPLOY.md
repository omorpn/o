# Deploying Chatly to Firebase

Chatly is a long-running Node server (SSE + SQLite), so it can't run as static Firebase Hosting or as Cloud Functions.
The supported Firebase path is **Cloud Run behind Firebase Hosting**. Run these on your machine (they need your Google login):

```bash
npm i -g firebase-tools && firebase login
gcloud auth login && gcloud config set project YOUR_FIREBASE_PROJECT_ID
cp .firebaserc.example .firebaserc   # edit the project id

# 1. Build & deploy the server to Cloud Run (single instance: realtime state lives in memory)
gcloud run deploy chatly --source . --region us-central1 --allow-unauthenticated \
  --min-instances 1 --max-instances 1 --no-cpu-throttling --timeout 3600 \
  --set-env-vars TRUST_PROXY=2,ADMIN_EMAIL=you@example.com,ADMIN_PASSWORD='choose-a-strong-one'
# Optional: ANTHROPIC_API_KEY, SMTP_URL, SMTP_FROM (use Secret Manager for real secrets)

# 2. Put it behind your Firebase Hosting domain
firebase deploy --only hosting
```

Dashboard: `https://YOUR_PROJECT.web.app/app/` · widget snippet: `<script src="https://YOUR_PROJECT.web.app/widget.js" data-key="KEY" async></script>`

## Things to know
- **Data is ephemeral by default.** Cloud Run's disk is wiped on restart/redeploy, so conversations and settings are lost. For durable data mount a volume and set `SQLITE_JOURNAL=delete`
  (e.g. Filestore NFS: `--add-volume name=data,type=nfs,location=IP:/share --add-volume-mount volume=data,mount-path=/data`), or move to a VM with a persistent disk.
- **One instance only** (`--max-instances 1`): online presence and live updates are kept in process memory.
- **Hosting proxy has a 60 s request limit**, so live connections reconnect about once a minute through `web.app` (they resume automatically). For fully uninterrupted realtime, serve
  the widget and dashboard from the Cloud Run URL directly (`https://chatly-xxxx.run.app`) and use `TRUST_PROXY=1`.
- Set `allowedOrigins` in Settings to your real site(s) once live.
