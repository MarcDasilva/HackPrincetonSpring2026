# Dedalus Machine Migration

This project uses Dedalus Machines for the Linux-side runtime. The Dedalus docs MCP URL can lag behind the actual Machines CLI, so use the CLI notation below as the operational reference.

Important: keep `DEDALUS_API_KEY` out of git. `.env` and `.env.*` are ignored locally, but any key pasted into chat or logs should be rotated after the migration.

## Branches

- `openclaw`: current orchestration branch with Supabase-backed foreman and worker runtimes.
- `main-server-openclaw-copy-20260418`: captured main-server/Voyager branch from the old VM. It contains the older Voyager/iMessage flow and a redacted OpenClaw gateway snapshot.

Default deploys use `openclaw`. To migrate the captured old VM code, pass `--branch=main-server-openclaw-copy-20260418` and use one of the legacy roles such as `voyager`, `multi-agent`, or `openclaw-gateways`.

## Create Machines

```bash
export DEDALUS_API_KEY="..."
node scripts/create-dedalus-machines.js --vcpu=2 --memory-mib=4096 --storage-gib=20
```

Copy the printed machine ids into `.env`:

```bash
DEDALUS_CONTROL_MACHINE_ID=
DEDALUS_WORKER_MINER_MACHINE_ID=
DEDALUS_WORKER_BUILDER_MACHINE_ID=
DEDALUS_WORKER_FORAGER_MACHINE_ID=
```

Raw CLI equivalent:

```bash
echo '{}' | dedalus machines create --vcpu 2 --memory-mib 4096 --storage-gib 20
```

## VM Secrets

Each Dedalus machine expects VM-local secrets in `/home/machine/openclaw.env`. At minimum, populate the Supabase, OpenClaw, Voyager, and Photon values required by the role you start.

Use an interactive Dedalus SSH/terminal session to create the file on each machine. Avoid passing secrets directly in CLI command arguments because execution commands may be logged. Do not commit real tokens. The bootstrap script sources `/home/machine/openclaw.env` before starting any role.

## Deploy Current Orchestrator

```bash
node scripts/deploy-control-vm.js
node scripts/deploy-worker-vm.js --worker=miner
node scripts/deploy-worker-vm.js --worker=builder
node scripts/deploy-worker-vm.js --worker=forager
```

The control VM starts `npm run foreman`. Worker VMs start `npm run worker:miner`, `npm run worker:builder`, and `npm run worker:forager`.

The deploy scripts pipe `{}` into the CLI and use JSON-array execution commands. The raw execution shape is:

```bash
echo '{}' | dedalus machines:executions create \
  --machine-id dm-... \
  --command '["/bin/bash","-c","echo hello"]'
```

To read execution output:

```bash
dedalus machines:executions output --machine-id dm-... --execution-id wexec-...
```

To create an HTTP preview:

```bash
echo '{}' | dedalus machines:previews create --machine-id dm-... --port 3000 --protocol http
```

## Deploy Captured Main-Server Code

For the older branch linked in the migration note:

```bash
node scripts/deploy-control-vm.js --branch=main-server-openclaw-copy-20260418 --role=voyager
```

To start only the captured OpenClaw gateway layout after putting real gateway tokens into `/home/machine/openclaw.env`:

```bash
node scripts/deploy-control-vm.js --branch=main-server-openclaw-copy-20260418 --role=openclaw-gateways
```

## Restart Roles

```bash
node scripts/restart-gateway.js --machine="$DEDALUS_CONTROL_MACHINE_ID" --role=foreman
node scripts/restart-gateway.js --machine="$DEDALUS_WORKER_MINER_MACHINE_ID" --role=worker-miner
```

To delete a machine:

```bash
dedalus machines delete --machine-id dm-... --if-match 1
```

Logs live under `/home/machine/logs` on each Dedalus machine.
