# OpenClaw And Dedalus

Dedalus topology:

- one control-plane VM running the foreman service
- three worker VMs: `worker-miner`, `worker-builder`, `worker-forager`

Each worker VM runs its own OpenClaw target and local Voyager adapter. The foreman and workers all talk to the same Supabase project.

Bootstrap installs into `/home/machine`, writes `/home/machine/start-gateway.sh`, and uses `setsid` so it does not rely on systemd user services.

The installed CLI exposes command execution through `dedalus machines:executions create --machine-id ... --command ...`. Use that primitive once a machine reaches `running`.
