import os
import time
import warnings
from typing import SupportsFloat, Any, Tuple, Dict

import requests
import json

import gymnasium as gym
from gymnasium.core import ObsType

import voyager.utils as U

from .minecraft_launcher import MinecraftInstance
from .process_monitor import SubprocessMonitor

MC_PORT_ENV_VAR = "VOYAGER_MC_PORT"
MC_HOST_ENV_VAR = "VOYAGER_MC_HOST"
SERVER_PORT_ENV_VAR = "VOYAGER_SERVER_PORT"
BOT_USERNAME_ENV_VAR = "VOYAGER_BOT_USERNAME"
MC_AUTH_ENV_VAR = "VOYAGER_MC_AUTH"
MC_PASSWORD_ENV_VAR = "VOYAGER_MC_PASSWORD"
MC_VERSION_ENV_VAR = "VOYAGER_MC_VERSION"
MC_PROFILES_DIR_ENV_VAR = "VOYAGER_MC_PROFILES_DIR"


def resolve_mc_host(mc_host=None):
    if mc_host in (None, ""):
        mc_host = os.getenv(MC_HOST_ENV_VAR, "localhost")
    mc_host = str(mc_host).strip()
    if not mc_host:
        raise ValueError(f"{MC_HOST_ENV_VAR} must not be empty")
    return mc_host


def resolve_mc_port(mc_port=None):
    if mc_port in (None, ""):
        mc_port = os.getenv(MC_PORT_ENV_VAR)
    if mc_port in (None, ""):
        return None
    try:
        return int(mc_port)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{MC_PORT_ENV_VAR} must be an integer, got {mc_port!r}"
        ) from exc


def resolve_server_port(server_port=None):
    if server_port in (None, ""):
        server_port = os.getenv(SERVER_PORT_ENV_VAR, 3000)
    try:
        return int(server_port)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{SERVER_PORT_ENV_VAR} must be an integer, got {server_port!r}"
        ) from exc


def resolve_bot_username(bot_username=None):
    if bot_username in (None, ""):
        bot_username = os.getenv(BOT_USERNAME_ENV_VAR, "bot")
    bot_username = str(bot_username).strip()
    if not bot_username:
        raise ValueError(f"{BOT_USERNAME_ENV_VAR} must not be empty")
    return bot_username


def resolve_mc_auth(mc_auth=None):
    if mc_auth in (None, ""):
        mc_auth = os.getenv(MC_AUTH_ENV_VAR, "offline")
    mc_auth = str(mc_auth).strip().lower()
    if mc_auth not in {"offline", "microsoft", "mojang"}:
        raise ValueError(
            f"{MC_AUTH_ENV_VAR} must be one of offline, microsoft, mojang; got {mc_auth!r}"
        )
    return mc_auth


def resolve_optional_env(value, env_var_name):
    if value in (None, ""):
        value = os.getenv(env_var_name)
    if value in (None, ""):
        return None
    return str(value)


class VoyagerEnv(gym.Env):
    def __init__(
        self,
        mc_host="localhost",
        mc_port=None,
        azure_login=None,
        server_host="http://127.0.0.1",
        server_port=3000,
        bot_username="bot",
        mc_auth=None,
        mc_password=None,
        mc_version=None,
        mc_profiles_dir=None,
        request_timeout=600,
        log_path="./logs",
    ):
        mc_host = resolve_mc_host(mc_host)
        mc_port = resolve_mc_port(mc_port)
        server_port = resolve_server_port(server_port)
        bot_username = resolve_bot_username(bot_username)
        mc_auth = resolve_mc_auth(mc_auth)
        mc_password = resolve_optional_env(mc_password, MC_PASSWORD_ENV_VAR)
        mc_version = resolve_optional_env(mc_version, MC_VERSION_ENV_VAR)
        mc_profiles_dir = resolve_optional_env(mc_profiles_dir, MC_PROFILES_DIR_ENV_VAR)
        if not mc_port and not azure_login:
            raise ValueError("Either mc_port or azure_login must be specified")
        if mc_port and azure_login:
            warnings.warn(
                "Both mc_port and mc_login are specified, mc_port will be ignored"
            )
        self.mc_host = mc_host
        self.mc_port = mc_port
        self.azure_login = azure_login
        self.server = f"{server_host}:{server_port}"
        self.server_port = server_port
        self.bot_username = bot_username
        self.mc_auth = mc_auth
        self.mc_password = mc_password
        self.mc_version = mc_version
        self.mc_profiles_dir = mc_profiles_dir
        self.request_timeout = request_timeout
        self.log_path = log_path
        self.mineflayer = self.get_mineflayer_process(server_port)
        if azure_login:
            self.mc_instance = self.get_mc_instance()
        else:
            self.mc_instance = None
        self.has_reset = False
        self.reset_options = None
        self.connected = False
        self.server_paused = False
        self.request_retry_count = int(os.getenv("VOYAGER_HTTP_RETRIES", "4"))
        self.request_retry_backoff = float(os.getenv("VOYAGER_HTTP_RETRY_BACKOFF_SEC", "1.0"))
        self.start_request_timeout = float(
            os.getenv("VOYAGER_START_REQUEST_TIMEOUT_SEC", "45.0")
        )
        self.start_retry_count = int(os.getenv("VOYAGER_START_RETRIES", "12"))
        self.start_retry_backoff = float(os.getenv("VOYAGER_START_RETRY_BACKOFF_SEC", "2.0"))
        self.start_throttle_wait = float(
            os.getenv("VOYAGER_START_THROTTLE_WAIT_SEC", "20.0")
        )
        self.reset_restarts_mineflayer = (
            os.getenv("VOYAGER_RESET_RESTART_MINEFLAYER", "0").strip() == "1"
        )

    def get_mineflayer_process(self, server_port):
        U.f_mkdir(self.log_path, "mineflayer")
        file_path = os.path.abspath(os.path.dirname(__file__))
        return SubprocessMonitor(
            commands=[
                "node",
                U.f_join(file_path, "mineflayer/index.js"),
                str(server_port),
            ],
            name="mineflayer",
            ready_match=r"Server started on port (\d+)",
            log_path=U.f_join(self.log_path, "mineflayer"),
        )

    def get_mc_instance(self):
        print("Creating Minecraft server")
        U.f_mkdir(self.log_path, "minecraft")
        return MinecraftInstance(
            **self.azure_login,
            mineflayer=self.mineflayer,
            log_path=U.f_join(self.log_path, "minecraft"),
        )

    def check_process(self):
        if self.mc_instance and not self.mc_instance.is_running:
            # if self.mc_instance:
            #     self.mc_instance.check_process()
            #     if not self.mc_instance.is_running:
            print("Starting Minecraft server")
            self.mc_instance.run()
            self.mc_port = self.mc_instance.port
            self.reset_options["port"] = self.mc_instance.port
            print(f"Server started on port {self.reset_options['port']}")
        if not self.mineflayer.is_running:
            print("Mineflayer process has exited, restarting")
            self.mineflayer.run()
            if not self.mineflayer.is_running:
                raise RuntimeError("Mineflayer process failed to start")
            # Mineflayer was restarted, force a new /start handshake.
            self.connected = False

        # Avoid reconnect churn: only call /start when not yet connected.
        if self.connected:
            return None

        retry = 0
        max_retries = max(1, self.start_retry_count)
        while retry < max_retries:
            print(self.mineflayer.ready_line)
            try:
                res = requests.post(
                    f"{self.server}/start",
                    json=self.reset_options,
                    timeout=self.start_request_timeout,
                )
            except requests.exceptions.RequestException as exc:
                self.connected = False
                retry += 1
                if retry >= max_retries:
                    raise RuntimeError(
                        f"Minecraft server start request failed after {max_retries} tries: {exc}"
                    ) from exc
                wait_seconds = max(1.0, self.start_retry_backoff * retry)
                print(
                    f"Minecraft server start request failed ({exc}), retrying "
                    f"({retry}/{max_retries - 1}) in {wait_seconds:.1f}s..."
                )
                if not self.mineflayer.is_running:
                    self.mineflayer.run()
                time.sleep(wait_seconds)
                continue
            if res.status_code == 200:
                self.connected = True
                return res.json()

            error_body = ""
            try:
                error_body = res.text
            except Exception:
                error_body = ""
            self.connected = False
            retry += 1
            if retry >= max_retries:
                raise RuntimeError(
                    f"Minecraft server reply with code {res.status_code}: {error_body}"
                )
            error_lower = str(error_body).lower()
            if "throttled" in error_lower or "please wait before reconnecting" in error_lower:
                wait_seconds = max(
                    self.start_throttle_wait,
                    self.start_throttle_wait + self.start_retry_backoff * (retry - 1),
                )
                print(
                    f"Minecraft server throttled reconnects; waiting {wait_seconds:.1f}s "
                    f"before retry ({retry}/{max_retries - 1})..."
                )
                if not self.mineflayer.is_running:
                    self.mineflayer.run()
                time.sleep(wait_seconds)
                continue
            wait_seconds = max(1.0, self.start_retry_backoff * retry)
            print(
                f"Minecraft server start failed ({res.status_code}), retrying "
                f"({retry}/{max_retries - 1}) in {wait_seconds:.1f}s..."
            )
            if not self.mineflayer.is_running:
                self.mineflayer.run()
            time.sleep(wait_seconds)

    def _reconnect_bridge(self):
        self.connected = False
        try:
            self.check_process()
        except Exception as reconnect_error:
            raise RuntimeError(f"Bridge reconnect failed: {reconnect_error}") from reconnect_error

    def step(
        self,
        code: str,
        programs: str = "",
    ) -> Tuple[ObsType, SupportsFloat, bool, bool, Dict[str, Any]]:
        if not self.has_reset:
            raise RuntimeError("Environment has not been reset yet")
        data = {
            "code": code,
            "programs": programs,
        }
        last_error = None
        max_retries = max(1, self.request_retry_count)

        for attempt in range(1, max_retries + 1):
            try:
                self.check_process()
                self.unpause()
                res = requests.post(
                    f"{self.server}/step", json=data, timeout=self.request_timeout
                )
                if res.status_code != 200:
                    raise RuntimeError(f"Failed to step Minecraft server (status {res.status_code})")
                returned_data = res.json()
                self.pause()
                return json.loads(returned_data)
            except (requests.exceptions.RequestException, RuntimeError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt >= max_retries:
                    break
                wait_seconds = self.request_retry_backoff * attempt
                print(
                    f"Step request failed ({exc}); reconnecting and retrying "
                    f"({attempt}/{max_retries - 1}) in {wait_seconds:.1f}s..."
                )
                time.sleep(wait_seconds)
                try:
                    self._reconnect_bridge()
                except Exception as reconnect_error:
                    last_error = reconnect_error
                    if attempt >= max_retries:
                        break

        raise RuntimeError(
            f"Failed to step Minecraft server after {max_retries} attempts: {last_error}"
        ) from last_error

    def render(self):
        raise NotImplementedError("render is not implemented")

    def reset(
        self,
        *,
        seed=None,
        options=None,
    ) -> Tuple[ObsType, Dict[str, Any]]:
        if options is None:
            options = {}

        if options.get("inventory", {}) and options.get("mode", "hard") != "hard":
            raise RuntimeError("inventory can only be set when options is hard")

        self.reset_options = {
            "host": self.mc_host,
            "port": self.mc_port,
            "username": self.bot_username,
            "auth": self.mc_auth,
            "reset": options.get("mode", "hard"),
            "inventory": options.get("inventory", {}),
            "equipment": options.get("equipment", []),
            "spread": options.get("spread", False),
            "waitTicks": options.get("wait_ticks", 5),
            "position": options.get("position", None),
        }
        if self.mc_password:
            self.reset_options["password"] = self.mc_password
        if self.mc_version:
            self.reset_options["version"] = self.mc_version
        if self.mc_profiles_dir:
            self.reset_options["profilesFolder"] = self.mc_profiles_dir

        self.unpause()
        if self.reset_restarts_mineflayer and self.mineflayer.is_running:
            self.mineflayer.stop()
            time.sleep(1)  # wait for mineflayer to exit

        # Force a /start handshake for each reset, but avoid process restarts by default.
        self.connected = False
        returned_data = self.check_process()
        self.has_reset = True
        self.connected = True
        # All the reset in step will be soft
        self.reset_options["reset"] = "soft"
        self.pause()
        return json.loads(returned_data)

    def close(self):
        self.unpause()
        if self.connected:
            res = requests.post(f"{self.server}/stop")
            if res.status_code == 200:
                self.connected = False
        if self.mc_instance:
            self.mc_instance.stop()
        self.mineflayer.stop()
        return not self.connected

    def pause(self):
        if not self.mc_instance:
            return self.server_paused
        if self.mineflayer.is_running and not self.server_paused:
            res = requests.post(f"{self.server}/pause")
            if res.status_code == 200:
                self.server_paused = True
        return self.server_paused

    def unpause(self):
        if not self.mc_instance:
            return self.server_paused
        if self.mineflayer.is_running and self.server_paused:
            res = requests.post(f"{self.server}/pause")
            if res.status_code == 200:
                self.server_paused = False
            else:
                print(res.json())
        return self.server_paused
