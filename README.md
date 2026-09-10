# Data(g)Market

Prediction markets for Data Guild events.

## Run locally

```bash
npm start
```

The app listens on `http://localhost:8791` and creates its SQLite database in
`data/markets.db`.

## Production

Create a `.env` from `.env.example` with the bot token from BotFather, then run:

```bash
docker compose up -d --build
```

Nginx Proxy Manager should forward `datamarket.nahi.online` to
`192.168.50.122:8791` over HTTP. TLS is terminated at the existing proxy and
Cloudflare tunnel.

Set `datamarket.nahi.online` as the bot domain in BotFather. The first Telegram
account to sign in becomes the founding admin.
Admins can appoint moderators from `/organizer`; only admins can resolve markets.

## Contributing

Development happens through pull requests. `main` should be protected in
GitHub so only reviewed, passing changes can reach production. Add friends as
collaborators under **Settings → Collaborators**; people without write access
can still contribute from forks.

The workflow in `.github/workflows/deploy.yml` checks every pull request. A
merge or manual dispatch on `main` deploys through a self-hosted runner carrying
the `datamarket` label. The production environment can require selected
reviewers under **Settings → Environments → production**, which controls who
may approve deployments. Never enable self-hosted jobs for pull requests from
untrusted forks.

Production state remains only on the server:

- `/home/nahiserver/projects/dg-markets/.env` contains the Telegram token.
- `/home/nahiserver/projects/dg-markets/data` contains SQLite and its backups.
- Neither path is committed or uploaded as an Actions artifact.
