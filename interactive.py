import argparse

from voyager import Voyager


def build_parser():
    parser = argparse.ArgumentParser(
        description="Run Voyager in interactive terminal mode."
    )
    parser.add_argument(
        "--mc-host",
        default=None,
        help="Minecraft server hostname. Defaults to VOYAGER_MC_HOST or localhost.",
    )
    parser.add_argument(
        "--mc-port",
        type=int,
        default=None,
        help="Minecraft server port. Defaults to VOYAGER_MC_PORT if omitted.",
    )
    parser.add_argument(
        "--server-port",
        type=int,
        default=None,
        help="Local Mineflayer bridge port for this bot. Defaults to VOYAGER_SERVER_PORT or 3000.",
    )
    parser.add_argument(
        "--bot-username",
        default=None,
        help="Minecraft username for this bot. Defaults to VOYAGER_BOT_USERNAME or bot.",
    )
    parser.add_argument(
        "--ckpt-dir",
        default="ckpt",
        help="Checkpoint directory for this bot.",
    )
    parser.add_argument(
        "--reset-mode",
        default="hard",
        choices=["hard", "soft"],
        help="Reset mode to use when interactive mode starts or /reset is used.",
    )
    return parser


def main():
    args = build_parser().parse_args()
    voyager = Voyager(
        mc_host=args.mc_host,
        mc_port=args.mc_port,
        server_port=args.server_port,
        bot_username=args.bot_username,
        ckpt_dir=args.ckpt_dir,
    )
    try:
        voyager.interactive(reset_mode=args.reset_mode, reset_env=False)
    finally:
        voyager.close()


if __name__ == "__main__":
    main()
