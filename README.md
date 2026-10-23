# Minecraft 24/7 Bot Dashboard (starter project)

A self-hosted control panel for **servers you own or are authorized to administer**. It includes a responsive dashboard, account login, SQLite persistence, Java bot connections, a Bedrock protocol connection adapter, player list, logs, inventory view (Java), reconnect settings, health endpoint, and deployment files.

## Important limitations

- This is a starter implementation, not a guarantee of 24/7 uptime. Free web hosts may sleep, restart containers, or stop long-running background processes. For persistent connections, use a VPS or a hosting plan that explicitly allows workers.
- Java and Bedrock use different protocols. The Java bot uses Mineflayer; Bedrock uses `bedrock-protocol`. Bedrock support here is a basic connection/status adapter; player actions, combat, follow/protect, and inventory controls are **Java-only** in this starter.
- PvP, follow, protect, eat, and inventory interactions are implemented as limited Java-side controls. They are not a full combat AI and may fail against plugins, custom inventories, anti-cheat, or version incompatibility.
- “Console” means sending a Minecraft chat command as the bot, **not** executing operating-system shell commands or server-console commands. The bot account must have the relevant permissions. Do not expose RCON or arbitrary shell execution publicly.
- Some servers prohibit AFK bots or automated PvP. Use only with permission and follow the server's rules.
- Keep `.env`, session secrets, and credentials private. Do not commit `.env` to GitHub.

## Requirements

- Node.js 20+
- A reachable Minecraft Java server and/or Bedrock server
- For Java online-mode servers, use a legitimate Microsoft-authenticated account. Authentication flow depends on Mineflayer version and may require interactive login. This starter defaults to offline mode only when explicitly configured as such; do not use offline mode to impersonate a real player.
- For Bedrock, authentication can require device-code/Xbox login depending on server setup. This starter uses a basic client adapter and does not store Microsoft credentials.

## Run locally

```bash
cp .env.example .env
# Set SESSION_SECRET to a long random value
npm install
npm start
```

Open `http://localhost:3000`. Register the first account; it becomes admin. After that, set `ALLOW_REGISTRATION=false` in `.env` and restart.

Data is stored in `data/app.sqlite`. Back it up before upgrades.

## Configure a server profile

1. Log in.
2. Add a profile with edition, host, port, username, and reconnect settings.
3. Press Connect. The Java adapter uses Mineflayer. The Bedrock adapter is a basic protocol connection.
4. Use the profile actions to start/stop, send a chat message/command, view Java players, view Java inventory, and issue limited actions.

For Java online-mode authentication, add an authentication adapter appropriate to your server and Mineflayer's current supported Microsoft login flow before using this on a public server. Never ask users to paste Microsoft passwords into this dashboard.

## Deployment

### Docker / VPS (recommended for persistent bots)

```bash
docker build -t mc-bot-dashboard .
docker run -d --name mc-bot-dashboard \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e SESSION_SECRET='a-long-random-secret' \
  -e ALLOW_REGISTRATION=true \
  -v "$PWD/data:/app/data" \
  --restart unless-stopped mc-bot-dashboard
```

Put it behind HTTPS (Caddy, Nginx, or your host's HTTPS proxy). Create the admin account, then disable public registration.

### Render free tier

`render.yaml` is included as a starting point. Free web services can sleep/restart and may not keep persistent background sockets alive. SQLite files on ephemeral disks can be lost; use a persistent disk or managed database if your chosen plan supports it. Do not assume Render free tier will provide 24/7 bot runtime.

## Feature status

- Included: login/register, role field, profile CRUD, dark/light theme, health endpoint, basic uptime stats, logs, log export, reconnect configuration, Java bot, basic Bedrock connect/status, Java player list, Java inventory snapshot, Java chat/command send, Java follow/stop-follow, basic attack and guard toggles, auto-eat attempt, backup/export endpoints.
- Partial: Bedrock player interactions/inventory, combat AI, authentication on online-mode servers, push notifications (dashboard live events work only while dashboard is open).
- Not included: arbitrary OS shell, unrestricted server-console/RCON execution, guaranteed uptime on free hosting, anti-cheat bypass, or a complete PvP bot.

## Security checklist before public deployment

- Set a strong random `SESSION_SECRET`.
- Use HTTPS.
- Disable registration after creating admin.
- Back up `data/`.
- Keep the dashboard private; add a reverse-proxy access policy if possible.
- Do not run this as root or expose a server console.
