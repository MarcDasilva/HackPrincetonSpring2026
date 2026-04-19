import copy
import os
import time
from typing import Dict

import voyager.utils as U

from .agents import ActionAgent, CriticAgent, CurriculumAgent, SkillManager
from .env import VoyagerEnv
from .llms import load_env_file
from .mcp_bridge import MCPContextBridge


# TODO: remove event memory
class Voyager:
    def __init__(
        self,
        mc_host: str = "localhost",
        mc_port: int = None,
        azure_login: Dict[str, str] = None,
        server_port: int = 3000,
        bot_username: str = "bot",
        mc_auth: str = None,
        mc_password: str = None,
        mc_version: str = None,
        mc_profiles_dir: str = None,
        cerebras_api_key: str = None,
        openai_api_key: str = None,
        cerebras_base_url: str = None,
        openai_embedding_model: str = None,
        env_wait_ticks: int = 20,
        env_request_timeout: int = 600,
        max_iterations: int = 160,
        reset_placed_if_failed: bool = False,
        action_agent_model_name: str = "gpt-4o-2024-08-06",
        action_agent_temperature: float = 0,
        action_agent_task_max_retries: int = 4,
        action_agent_show_chat_log: bool = True,
        action_agent_show_execution_error: bool = True,
        curriculum_agent_model_name: str = "gpt-4o-2024-08-06",
        curriculum_agent_temperature: float = 0,
        curriculum_agent_qa_model_name: str = "gpt-4o-2024-08-06",
        curriculum_agent_qa_temperature: float = 0,
        curriculum_agent_warm_up: Dict[str, int] = None,
        curriculum_agent_core_inventory_items: str = r".*_log|.*_planks|stick|crafting_table|furnace"
        r"|cobblestone|dirt|coal|.*_pickaxe|.*_sword|.*_axe",
        curriculum_agent_mode: str = "auto",
        critic_agent_model_name: str = "gpt-4o-2024-08-06",
        critic_agent_temperature: float = 0,
        critic_agent_mode: str = "auto",
        skill_manager_model_name: str = "gpt-4o-2024-08-06",
        skill_manager_temperature: float = 0,
        skill_manager_retrieval_top_k: int = 5,
        openai_api_request_timeout: int = 240,
        ckpt_dir: str = "ckpt",
        skill_library_dir: str = None,
        resume: bool = False,
        mcp_context_enabled: bool | None = None,
        mcp_context_command: str = None,
        mcp_context_timeout_sec: float = None,
        mcp_context_max_chars: int = None,
    ):
        """
        The main class for Voyager.
        Action agent is the iterative prompting mechanism in paper.
        Curriculum agent is the automatic curriculum in paper.
        Critic agent is the self-verification in paper.
        Skill manager is the skill library in paper.
        :param mc_host: minecraft server host
        :param mc_port: minecraft server port
        :param azure_login: minecraft login config
        :param server_port: mineflayer port
        :param bot_username: minecraft username for the mineflayer bot
        :param mc_auth: mineflayer auth mode, e.g. offline or microsoft
        :param mc_password: optional password for authenticated servers
        :param mc_version: optional minecraft protocol version
        :param mc_profiles_dir: optional directory to cache mineflayer auth tokens
        :param cerebras_api_key: cerebras api key for all chat completions
        :param openai_api_key: openai api key for embeddings used by Chroma retrieval
        :param cerebras_base_url: cerebras-compatible OpenAI base url
        :param openai_embedding_model: openai embedding model name
        :param env_wait_ticks: how many ticks at the end each step will wait, if you found some chat log missing,
        you should increase this value
        :param env_request_timeout: how many seconds to wait for each step, if the code execution exceeds this time,
        python side will terminate the connection and need to be resumed
        :param reset_placed_if_failed: whether to reset placed blocks if failed, useful for building task
        :param action_agent_model_name: action agent model name
        :param action_agent_temperature: action agent temperature
        :param action_agent_task_max_retries: how many times to retry if failed
        :param curriculum_agent_model_name: curriculum agent model name
        :param curriculum_agent_temperature: curriculum agent temperature
        :param curriculum_agent_qa_model_name: curriculum agent qa model name
        :param curriculum_agent_qa_temperature: curriculum agent qa temperature
        :param curriculum_agent_warm_up: info will show in curriculum human message
        if completed task larger than the value in dict, available keys are:
        {
            "context": int,
            "biome": int,
            "time": int,
            "other_blocks": int,
            "nearby_entities": int,
            "health": int,
            "hunger": int,
            "position": int,
            "equipment": int,
            "chests": int,
            "optional_inventory_items": int,
        }
        :param curriculum_agent_core_inventory_items: only show these items in inventory before optional_inventory_items
        reached in warm up
        :param curriculum_agent_mode: "auto" for automatic curriculum, "manual" for human curriculum
        :param critic_agent_model_name: critic agent model name
        :param critic_agent_temperature: critic agent temperature
        :param critic_agent_mode: "auto" for automatic critic ,"manual" for human critic
        :param skill_manager_model_name: skill manager model name
        :param skill_manager_temperature: skill manager temperature
        :param skill_manager_retrieval_top_k: how many skills to retrieve for each task
        :param openai_api_request_timeout: how many seconds to wait for chat and embedding APIs
        :param ckpt_dir: checkpoint dir
        :param skill_library_dir: skill library dir
        :param resume: whether to resume from checkpoint
        :param mcp_context_enabled: enable/disable MCP context enrichment hook
        :param mcp_context_command: shell command used to retrieve MCP context JSON
        :param mcp_context_timeout_sec: timeout for MCP context command
        :param mcp_context_max_chars: max context chars after MCP enrichment merge
        """
        # load .env values first so env-backed config is available during env setup
        load_env_file()

        # init env
        self.env = VoyagerEnv(
            mc_host=mc_host,
            mc_port=mc_port,
            azure_login=azure_login,
            server_port=server_port,
            bot_username=bot_username,
            mc_auth=mc_auth,
            mc_password=mc_password,
            mc_version=mc_version,
            mc_profiles_dir=mc_profiles_dir,
            request_timeout=env_request_timeout,
        )
        self.env_wait_ticks = env_wait_ticks
        self.reset_placed_if_failed = reset_placed_if_failed
        self.max_iterations = max_iterations

        # allow constructor args to override .env values
        if cerebras_api_key:
            os.environ["CEREBRAS_API_KEY"] = cerebras_api_key
            os.environ["K2_API_KEY"] = cerebras_api_key
        if openai_api_key:
            os.environ["OPENAI_API_KEY"] = openai_api_key
        if cerebras_base_url:
            os.environ["CEREBRAS_BASE_URL"] = cerebras_base_url
            os.environ["K2_BASE_URL"] = cerebras_base_url
        if openai_embedding_model:
            os.environ["OPENAI_EMBEDDING_MODEL"] = openai_embedding_model

        # init agents
        self.action_agent = ActionAgent(
            model_name=action_agent_model_name,
            temperature=action_agent_temperature,
            request_timout=openai_api_request_timeout,
            ckpt_dir=ckpt_dir,
            resume=resume,
            chat_log=action_agent_show_chat_log,
            execution_error=action_agent_show_execution_error,
        )
        self.action_agent_task_max_retries = action_agent_task_max_retries
        self.curriculum_agent = CurriculumAgent(
            model_name=curriculum_agent_model_name,
            temperature=curriculum_agent_temperature,
            qa_model_name=curriculum_agent_qa_model_name,
            qa_temperature=curriculum_agent_qa_temperature,
            request_timout=openai_api_request_timeout,
            ckpt_dir=ckpt_dir,
            resume=resume,
            mode=curriculum_agent_mode,
            warm_up=curriculum_agent_warm_up,
            core_inventory_items=curriculum_agent_core_inventory_items,
        )
        self.critic_agent = CriticAgent(
            model_name=critic_agent_model_name,
            temperature=critic_agent_temperature,
            request_timout=openai_api_request_timeout,
            mode=critic_agent_mode,
        )
        self.skill_manager = SkillManager(
            model_name=skill_manager_model_name,
            temperature=skill_manager_temperature,
            retrieval_top_k=skill_manager_retrieval_top_k,
            request_timout=openai_api_request_timeout,
            ckpt_dir=skill_library_dir if skill_library_dir else ckpt_dir,
            resume=True if resume or skill_library_dir else False,
        )
        self.recorder = U.EventRecorder(ckpt_dir=ckpt_dir, resume=resume)
        self.resume = resume

        # init variables for rollout
        self.action_agent_rollout_num_iter = -1
        self.task = None
        self.context = ""
        self.messages = None
        self.conversations = []
        self.last_events = None
        self.restore_position_after_failure = (
            os.getenv("VOYAGER_RESTORE_POSITION_AFTER_FAILURE", "0").strip().lower()
            not in {"0", "false", "no", "off"}
        )
        self.mcp_context_bridge = MCPContextBridge(
            enabled=mcp_context_enabled,
            command=mcp_context_command,
            timeout_sec=mcp_context_timeout_sec,
            max_context_chars=mcp_context_max_chars,
        )
        if self.mcp_context_bridge.ready:
            print(
                f"\033[36mMCP context bridge enabled via command: {self.mcp_context_bridge.command}\033[0m"
            )

    @staticmethod
    def _latest_observation_from_events(events):
        if not events:
            raise RuntimeError(
                "Minecraft step returned no events. The Mineflayer process likely crashed before producing an observation."
            )
        event_type, event = events[-1]
        if event_type != "observe":
            raise RuntimeError(
                f"Minecraft step ended with '{event_type}' instead of 'observe'."
            )
        return event

    def reset(self, task, context="", reset_env=True):
        self.action_agent_rollout_num_iter = 0
        self.task = task
        self.context = context
        if reset_env:
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        difficulty = (
            "easy" if len(self.curriculum_agent.completed_tasks) > 15 else "peaceful"
        )
        # step to peek an observation
        events = self.env.step(
            "bot.chat(`/time set ${getNextTime()}`);\n"
            + f"bot.chat('/difficulty {difficulty}');"
        )
        self.task, self.context = self._enrich_task_context_with_mcp(
            task=self.task,
            context=self.context,
            events=events,
            phase="reset",
        )
        skills = self.skill_manager.retrieve_skills(query=self.context)
        print(
            f"\033[33mRender Action Agent system message with {len(skills)} skills\033[0m"
        )
        system_message = self.action_agent.render_system_message(skills=skills)
        human_message = self.action_agent.render_human_message(
            events=events, code="", task=self.task, context=self.context, critique=""
        )
        self.messages = [system_message, human_message]
        print(
            f"\033[32m****Action Agent human message****\n{human_message.content}\033[0m"
        )
        assert len(self.messages) == 2
        self.conversations = []
        return self.messages

    def _enrich_task_context_with_mcp(self, *, task, context, events, phase):
        try:
            observation = self._latest_observation_from_events(events)
        except Exception:
            observation = {}
        enrichment = self.mcp_context_bridge.enrich_task_context(
            task=task,
            context=context,
            observation=observation,
            completed_tasks=self.curriculum_agent.completed_tasks,
            failed_tasks=self.curriculum_agent.failed_tasks,
            phase=phase,
        )
        if enrichment.get("used"):
            source = enrichment.get("source") or "mcp"
            print(
                f"\033[36mApplied MCP context enrichment ({source}) for task '{enrichment['task']}'.\033[0m"
            )
        elif enrichment.get("error") and self.mcp_context_bridge.enabled:
            print(
                f"\033[33mMCP context enrichment skipped due to error: {enrichment['error']}\033[0m"
            )
        return enrichment["task"], enrichment["context"]

    def close(self):
        self.env.close()

    def _recover_last_events_after_failure(self):
        time.sleep(3)  # wait for mineflayer to exit
        reset_options = {
            "mode": "hard",
            "wait_ticks": self.env_wait_ticks,
        }
        if self.last_events:
            last_observation = self._latest_observation_from_events(self.last_events)
            reset_options["inventory"] = last_observation["inventory"]
            reset_options["equipment"] = last_observation["status"]["equipment"]
            if self.restore_position_after_failure:
                reset_options["position"] = last_observation["status"]["position"]
        self.last_events = self.env.reset(options=reset_options)
        return self.last_events

    def step(self):
        if self.action_agent_rollout_num_iter < 0:
            raise ValueError("Agent must be reset before stepping")
        ai_message = self.action_agent.llm(self.messages)
        print(f"\033[34m****Action Agent ai message****\n{ai_message.content}\033[0m")
        self.conversations.append(
            (self.messages[0].content, self.messages[1].content, ai_message.content)
        )
        parsed_result = self.action_agent.process_ai_message(message=ai_message)
        success = False
        if isinstance(parsed_result, dict):
            code = parsed_result["program_code"] + "\n" + parsed_result["exec_code"]
            events = self.env.step(
                code,
                programs=self.skill_manager.programs,
            )
            latest_observation = self._latest_observation_from_events(events)
            self.recorder.record(events, self.task)
            self.action_agent.update_chest_memory(latest_observation["nearbyChests"])
            success, critique = self.critic_agent.check_task_success(
                events=events,
                task=self.task,
                context=self.context,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
            )

            if self.reset_placed_if_failed and not success:
                # revert all the placing event in the last step
                blocks = []
                positions = []
                for event_type, event in events:
                    if event_type == "onSave" and event["onSave"].endswith("_placed"):
                        block = event["onSave"].split("_placed")[0]
                        position = event["status"]["position"]
                        blocks.append(block)
                        positions.append(position)
                new_events = self.env.step(
                    f"await givePlacedItemBack(bot, {U.json_dumps(blocks)}, {U.json_dumps(positions)})",
                    programs=self.skill_manager.programs,
                )
                reverted_observation = self._latest_observation_from_events(new_events)
                latest_observation["inventory"] = reverted_observation["inventory"]
                latest_observation["voxels"] = reverted_observation["voxels"]
            new_skills = self.skill_manager.retrieve_skills(
                query=self.context
                + "\n\n"
                + self.action_agent.summarize_chatlog(events)
            )
            system_message = self.action_agent.render_system_message(skills=new_skills)
            human_message = self.action_agent.render_human_message(
                events=events,
                code=parsed_result["program_code"],
                task=self.task,
                context=self.context,
                critique=critique,
            )
            self.last_events = copy.deepcopy(events)
            self.messages = [system_message, human_message]
        else:
            assert isinstance(parsed_result, str)
            self.recorder.record([], self.task)
            print(f"\033[34m{parsed_result} Trying again!\033[0m")
        assert len(self.messages) == 2
        self.action_agent_rollout_num_iter += 1
        done = (
            self.action_agent_rollout_num_iter >= self.action_agent_task_max_retries
            or success
        )
        info = {
            "task": self.task,
            "success": success,
            "conversations": self.conversations,
        }
        if success:
            assert (
                "program_code" in parsed_result and "program_name" in parsed_result
            ), "program and program_name must be returned when success"
            info["program_code"] = parsed_result["program_code"]
            info["program_name"] = parsed_result["program_name"]
        else:
            print(
                f"\033[32m****Action Agent human message****\n{self.messages[-1].content}\033[0m"
            )
        return self.messages, 0, done, info

    def rollout(self, *, task, context, reset_env=True):
        self.reset(task=task, context=context, reset_env=reset_env)
        while True:
            messages, reward, done, info = self.step()
            if done:
                break
        return messages, reward, done, info

    def run_single_task_attempt(self, *, task, context, reset_env=False):
        self.reset(task=task, context=context, reset_env=reset_env)
        return self.step()

    def interactive(self, reset_mode="hard", reset_env=False):
        print("Interactive Voyager")
        print("Type a task and press Enter.")
        print("Optional context: task || context")
        print("Commands: /help, /reset, /status, /quit")
        print("Each task entry runs one attempt and then returns to the prompt.")
        print("Press Ctrl+C during a task to interrupt and enter a new one.")

        self.env.reset(
            options={
                "mode": reset_mode,
                "wait_ticks": self.env_wait_ticks,
            }
        )
        self.resume = True
        self.last_events = self.env.step("")

        while True:
            try:
                raw = input("\nTask> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nExiting interactive mode.")
                break

            if not raw:
                continue
            if raw in {"/quit", "/exit"}:
                break
            if raw == "/help":
                print("Enter a task like: Craft 4 spruce planks")
                print("Or include context: Craft 4 spruce planks || Use the spruce log in inventory.")
                print("Use /reset to reset the environment and /status to show the latest observation.")
                continue
            if raw == "/reset":
                self.last_events = self.env.reset(
                    options={
                        "mode": reset_mode,
                        "wait_ticks": self.env_wait_ticks,
                    }
                )
                print("Environment reset.")
                continue
            if raw == "/status":
                if self.last_events:
                    print(self.action_agent.render_human_message(
                        events=self.last_events,
                        code="",
                        task=self.task or "None",
                        context=self.context or "",
                        critique="",
                    ).content)
                else:
                    print("No observation available yet.")
                continue

            task, context = raw, ""
            if "||" in raw:
                task, context = [part.strip() for part in raw.split("||", 1)]

            print(f"\033[35mStarting task {task} for one attempt\033[0m")
            try:
                _, _, _, info = self.run_single_task_attempt(
                    task=task,
                    context=context,
                    reset_env=reset_env,
                )
            except KeyboardInterrupt:
                print("\nTask interrupted. Recovering environment...")
                self._recover_last_events_after_failure()
                self.action_agent_rollout_num_iter = -1
                continue
            except Exception as e:
                info = {
                    "task": task,
                    "success": False,
                }
                self._recover_last_events_after_failure()
                self.action_agent_rollout_num_iter = -1
                print("Your last round rollout terminated due to error:")
                print(f"\033[41m{e}\033[0m")

            if info["success"]:
                self.skill_manager.add_new_skill(info)
                print(f"\033[35mTask succeeded: {task}\033[0m")
            else:
                print(f"\033[35mTask attempt finished without success: {task}\033[0m")

    def learn(self, reset_env=True):
        if self.resume:
            # keep the inventory
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        else:
            # clear the inventory
            self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
            self.resume = True
        self.last_events = self.env.step("")

        while True:
            if self.recorder.iteration > self.max_iterations:
                print("Iteration limit reached")
                break
            task, context = self.curriculum_agent.propose_next_task(
                events=self.last_events,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
            )
            print(
                f"\033[35mStarting task {task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )
            try:
                messages, reward, done, info = self.rollout(
                    task=task,
                    context=context,
                    reset_env=reset_env,
                )
            except Exception as e:
                time.sleep(3)  # wait for mineflayer to exit
                info = {
                    "task": task,
                    "success": False,
                }
                # reset bot status here
                reset_options = {
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
                if self.last_events:
                    last_observation = self._latest_observation_from_events(
                        self.last_events
                    )
                    reset_options["inventory"] = last_observation["inventory"]
                    reset_options["equipment"] = last_observation["status"][
                        "equipment"
                    ]
                    if self.restore_position_after_failure:
                        reset_options["position"] = last_observation["status"]["position"]
                self.last_events = self.env.reset(options=reset_options)
                # use red color background to print the error
                print("Your last round rollout terminated due to error:")
                print(f"\033[41m{e}\033[0m")

            if info["success"]:
                self.skill_manager.add_new_skill(info)

            self.curriculum_agent.update_exploration_progress(info)
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )

        return {
            "completed_tasks": self.curriculum_agent.completed_tasks,
            "failed_tasks": self.curriculum_agent.failed_tasks,
            "skills": self.skill_manager.skills,
        }

    def decompose_task(self, task):
        if not self.last_events:
            self.last_events = self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        try:
            latest_observation = self._latest_observation_from_events(self.last_events)
            nearby_chests = latest_observation.get("nearbyChests", {})
            if isinstance(nearby_chests, dict):
                self.action_agent.update_chest_memory(nearby_chests)
        except Exception:
            # Best effort only; decomposition can still proceed without chest memory.
            pass

        chest_observation = self.action_agent.render_chest_observation()
        return self.curriculum_agent.decompose_task(
            task,
            self.last_events,
            chest_observation=chest_observation,
        )

    def inference(self, task=None, sub_goals=[], reset_mode="hard", reset_env=True):
        if not task and not sub_goals:
            raise ValueError("Either task or sub_goals must be provided")
        if not sub_goals:
            sub_goals = self.decompose_task(task)
        self.env.reset(
            options={
                "mode": reset_mode,
                "wait_ticks": self.env_wait_ticks,
            }
        )
        self.curriculum_agent.completed_tasks = []
        self.curriculum_agent.failed_tasks = []
        self.last_events = self.env.step("")
        while self.curriculum_agent.progress < len(sub_goals):
            next_task = sub_goals[self.curriculum_agent.progress]
            context = self.curriculum_agent.get_task_context(next_task)
            print(
                f"\033[35mStarting task {next_task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )
            messages, reward, done, info = self.rollout(
                task=next_task,
                context=context,
                reset_env=reset_env,
            )
            self.curriculum_agent.update_exploration_progress(info)
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )
