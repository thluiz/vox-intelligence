# Deployment

## systemd unit

`vox-intelligence.service` é uma cópia versionada do unit instalado em
`/etc/systemd/system/vox-intelligence.service` no host (HermesTools WSL distro).

O serviço roda como o usuário `hermes`, a partir de
`/home/hermes/services/vox-intelligence`, com o Bun (`~/.bun/bin/bun run server.ts`).
Escuta em `PORT` (default 8004) e é exposto via nginx em
`http://localhost:8080/api/vox-intelligence/` (config do nginx vive no repo
`vox-infra`).

### Secrets (NÃO versionados)

O unit **não** carrega secrets inline — o Bun lê automaticamente o arquivo
`.env` no `WorkingDirectory`. Criar a partir do template:

```bash
cp .env.example .env
# editar .env com as chaves reais (cofre pessoal, nunca commitar):
#   OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY
#   PORT, OLLAMA_URL, DEFAULT_MODELS, MAX_OUTPUT_TOKENS
```

### Pré-requisitos no host

- `bun` em `~/.bun/bin/bun` (`curl -fsSL https://bun.sh/install | bash`)
- Repo clonado em `/home/hermes/services/vox-intelligence`
- `.env` preenchido (acima)

### Instalar / atualizar

```bash
# Como root na distro:
cp deploy/vox-intelligence.service /etc/systemd/system/vox-intelligence.service
systemctl daemon-reload
systemctl enable --now vox-intelligence
```

Após alterações no unit ou no `.env`:

```bash
systemctl daemon-reload   # só se o unit mudou
systemctl restart vox-intelligence
systemctl status vox-intelligence
```

### Deploy de código

```bash
# Como hermes:
git -C /home/hermes/services/vox-intelligence pull --ff-only
sudo systemctl restart vox-intelligence
```

Health check:

```bash
curl -s http://localhost:8080/api/vox-intelligence/health
```
