# Deploying Chatly to Firebase

Chatly is a long-running Node server (SSE + SQLite), so it can't run as static Firebase Hosting or as Cloud Functions.
The supported Firebase path is **Cloud Run behind Firebase Hosting**.

## Easiest: Google Cloud Shell (nothing to install)
Open https://shell.cloud.google.com (it already has `gcloud`, `firebase` and `git`), then:

```bash
git clone -b claude/gallant-thompson-k1jkp5 https://github.com/omorpn/o.git chatly && cd chatly
gcloud config set project YOUR_FIREBASE_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
cp .firebaserc.example .firebaserc && sed -i "s/YOUR_FIREBASE_PROJECT_ID/$(gcloud config get-value project)/" .firebaserc
# then run steps 1 and 2 below from inside the chatly folder
```
Your Firebase project must be on the **Blaze (pay-as-you-go)** plan to use Cloud Run.

## Or on your own machine
Install the Google Cloud CLI first (Windows: https://cloud.google.com/sdk/docs/install), clone the repo as above and **run every command from inside the repo folder**.


```bash
npm i -g firebase-tools && firebase login
gcloud auth login && gcloud config set project YOUR_FIREBASE_PROJECT_ID
cp .firebaserc.example .firebaserc   # edit the project id

# 1. Build & deploy the server to Cloud Run (single instance: realtime state lives in memory)
gcloud run deploy chatly --source . --region us-central1 --allow-unauthenticated \
  --min-instances 1 --max-instances 1 --no-cpu-throttling --timeout 3600 \
  --set-env-vars TRUST_PROXY=2,DEMO=0,PUBLIC_URL=https://YOUR_PROJECT.web.app,PLATFORM_ADMINS=you@example.com,ADMIN_EMAIL=you@example.com,ADMIN_PASSWORD='choose-a-strong-one'
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

## Multi-workspace notes
- Anyone can sign up at `/app/` and get their own workspace. Set `ALLOW_SIGNUP=0` to make it invite-only.
- `DEMO=0` stops the page at `/` from showing the first workspace's widget. It then works as a test page: open `/?key=YOUR_SITE_KEY`, or press **Test widget** in Settings → Websites.
- A database created by the older single-workspace version is refused at startup with a clear message; start with a fresh `DB_FILE`.
- `TRUST_PROXY` must match your setup (2 behind Firebase Hosting → Cloud Run, 1 for Cloud Run directly). Fraud detection, IP blocks and rate limits rely on seeing the real visitor IP.
- The first account (and anyone in `PLATFORM_ADMINS`) is a platform admin with the Platform console and Fraud & abuse review queue.
- `PUBLIC_URL` makes links in notification emails and push messages point at your dashboard. Push keys are generated on first start and stored in the database; with ephemeral storage set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` so browser subscriptions survive redeploys.
- **Email channel**: the inbound address shown under Settings → Email channel uses `PUBLIC_URL` (otherwise the request host). Firebase Hosting rewrites only `/api/**` from your domain, which covers `/api/inbound/email/…`, so providers can post to `https://YOUR_PROJECT.web.app/api/inbound/email/<token>`. Replies are sent through `SMTP_URL`/`SMTP_FROM` with `Reply-To` set to the mailbox address.
- **AI knowledge**: the crawler only fetches public addresses (private, loopback and cloud-metadata IPs are refused). `ANTHROPIC_API_KEY` turns on written answers (`AI_MODEL` to change the model); without it the bot quotes the best passage.
