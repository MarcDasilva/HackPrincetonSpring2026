import re
import time

import voyager.utils as U
from javascript import require
from langchain.prompts import SystemMessagePromptTemplate
from langchain.schema import AIMessage, HumanMessage, SystemMessage

from voyager.prompts import load_prompt
from voyager.control_primitives_context import load_control_primitives_context
from voyager.llms import CerebrasChatModel


class ActionAgent:
    def __init__(
        self,
        model_name="MBZUAI-IFM/K2-Think-v2",
        temperature=0,
        request_timout=120,
        ckpt_dir="ckpt",
        resume=False,
        chat_log=True,
        execution_error=True,
    ):
        self.ckpt_dir = ckpt_dir
        self.chat_log = chat_log
        self.execution_error = execution_error
        U.f_mkdir(f"{ckpt_dir}/action")
        if resume:
            print(f"\033[32mLoading Action Agent from {ckpt_dir}/action\033[0m")
            self.chest_memory = U.load_json(f"{ckpt_dir}/action/chest_memory.json")
        else:
            self.chest_memory = {}
        self.llm = CerebrasChatModel(
            model_name=model_name,
            temperature=temperature,
            request_timeout=request_timout,
        )

    def update_chest_memory(self, chests):
        for position, chest in chests.items():
            if position in self.chest_memory:
                if isinstance(chest, dict):
                    self.chest_memory[position] = chest
                if chest == "Invalid":
                    print(
                        f"\033[32mAction Agent removing chest {position}: {chest}\033[0m"
                    )
                    self.chest_memory.pop(position)
            else:
                if chest != "Invalid":
                    print(f"\033[32mAction Agent saving chest {position}: {chest}\033[0m")
                    self.chest_memory[position] = chest
        U.dump_json(self.chest_memory, f"{self.ckpt_dir}/action/chest_memory.json")

    def render_chest_observation(self):
        chests = []
        for chest_position, chest in self.chest_memory.items():
            if isinstance(chest, dict) and len(chest) > 0:
                chests.append(f"{chest_position}: {chest}")
        for chest_position, chest in self.chest_memory.items():
            if isinstance(chest, dict) and len(chest) == 0:
                chests.append(f"{chest_position}: Empty")
        for chest_position, chest in self.chest_memory.items():
            if isinstance(chest, str):
                assert chest == "Unknown"
                chests.append(f"{chest_position}: Unknown items inside")
        assert len(chests) == len(self.chest_memory)
        if chests:
            chests = "\n".join(chests)
            return f"Chests:\n{chests}\n\n"
        else:
            return f"Chests: None\n\n"

    def render_system_message(self, skills=[]):
        system_template = load_prompt("action_template")
        # FIXME: Hardcoded control_primitives
        base_skills = [
            "exploreUntil",
            "mineBlock",
            "craftItem",
            "placeItem",
            "smeltItem",
            "killMob",
            "useChest",
            "mineflayer",
        ]
        programs = "\n\n".join(load_control_primitives_context(base_skills) + skills)
        response_format = load_prompt("action_response_format")
        system_message_prompt = SystemMessagePromptTemplate.from_template(
            system_template
        )
        system_message = system_message_prompt.format(
            programs=programs, response_format=response_format
        )
        assert isinstance(system_message, SystemMessage)
        return system_message

    def render_human_message(
        self, *, events, code="", task="", context="", critique=""
    ):
        chat_messages = []
        error_messages = []
        # FIXME: damage_messages is not used
        damage_messages = []
        assert events[-1][0] == "observe", "Last event must be observe"
        for i, (event_type, event) in enumerate(events):
            if event_type == "onChat":
                chat_messages.append(event["onChat"])
            elif event_type == "onError":
                error_messages.append(event["onError"])
            elif event_type == "onDamage":
                damage_messages.append(event["onDamage"])
            elif event_type == "observe":
                biome = event["status"]["biome"]
                time_of_day = event["status"]["timeOfDay"]
                voxels = event["voxels"]
                entities = event["status"]["entities"]
                health = event["status"]["health"]
                hunger = event["status"]["food"]
                position = event["status"]["position"]
                equipment = event["status"]["equipment"]
                inventory_used = event["status"]["inventoryUsed"]
                inventory = event["inventory"]
                assert i == len(events) - 1, "observe must be the last event"

        observation = ""

        if code:
            observation += f"Code from the last round:\n{code}\n\n"
        else:
            observation += f"Code from the last round: No code in the first round\n\n"

        if self.execution_error:
            if error_messages:
                error = "\n".join(error_messages)
                observation += f"Execution error:\n{error}\n\n"
            else:
                observation += f"Execution error: No error\n\n"

        if self.chat_log:
            if chat_messages:
                chat_log = "\n".join(chat_messages)
                observation += f"Chat log: {chat_log}\n\n"
            else:
                observation += f"Chat log: None\n\n"

        observation += f"Biome: {biome}\n\n"

        observation += f"Time: {time_of_day}\n\n"

        if voxels:
            observation += f"Nearby blocks: {', '.join(voxels)}\n\n"
        else:
            observation += f"Nearby blocks: None\n\n"

        if entities:
            nearby_entities = [
                k for k, v in sorted(entities.items(), key=lambda x: x[1])
            ]
            observation += f"Nearby entities (nearest to farthest): {', '.join(nearby_entities)}\n\n"
        else:
            observation += f"Nearby entities (nearest to farthest): None\n\n"

        observation += f"Health: {health:.1f}/20\n\n"

        observation += f"Hunger: {hunger:.1f}/20\n\n"

        observation += f"Position: x={position['x']:.1f}, y={position['y']:.1f}, z={position['z']:.1f}\n\n"

        observation += f"Equipment: {equipment}\n\n"

        if inventory:
            observation += f"Inventory ({inventory_used}/36): {inventory}\n\n"
        else:
            observation += f"Inventory ({inventory_used}/36): Empty\n\n"

        if not (
            task == "Place and deposit useless items into a chest"
            or task.startswith("Deposit useless items into the chest at")
        ):
            observation += self.render_chest_observation()

        observation += f"Task: {task}\n\n"

        if context:
            observation += f"Context: {context}\n\n"
        else:
            observation += f"Context: None\n\n"

        if critique:
            observation += f"Critique: {critique}\n\n"
        else:
            observation += f"Critique: None\n\n"

        return HumanMessage(content=observation)

    def process_ai_message(self, message):
        assert isinstance(message, AIMessage)

        retry = 3
        error = None
        while retry > 0:
            try:
                babel = require("@babel/core")
                babel_generator = require("@babel/generator").default

                code = self._prepare_code_for_parse(
                    self._extract_code_from_message(message.content)
                )
                parsed = babel.parse(code)
                functions = []
                assert len(list(parsed.program.body)) > 0, "No functions found"
                for i, node in enumerate(parsed.program.body):
                    if node.type != "FunctionDeclaration":
                        continue
                    node_type = (
                        "AsyncFunctionDeclaration"
                        if node["async"]
                        else "FunctionDeclaration"
                    )
                    functions.append(
                        {
                            "name": node.id.name,
                            "type": node_type,
                            "body": babel_generator(node).code,
                            "params": list(node["params"]),
                        }
                    )
                # find the last async function
                main_function = None
                for function in reversed(functions):
                    if function["type"] == "AsyncFunctionDeclaration":
                        main_function = function
                        break
                assert (
                    main_function is not None
                ), "No async function found. Your main function must be async."
                assert (
                    len(main_function["params"]) == 1
                    and main_function["params"][0].name == "bot"
                ), f"Main function {main_function['name']} must take a single argument named 'bot'"
                program_code = "\n\n".join(function["body"] for function in functions)
                exec_code = f"await {main_function['name']}(bot);"
                return {
                    "program_code": program_code,
                    "program_name": main_function["name"],
                    "exec_code": exec_code,
                }
            except Exception as e:
                retry -= 1
                error = e
                time.sleep(1)
        return f"Error parsing action response (before program execution): {error}"

    def build_task_fallback(self, task):
        parsed = self._parse_simple_task(task)
        if not parsed:
            return None

        action = parsed["action"]
        target = parsed["target"]
        quantity = parsed["quantity"]
        function_name = self._fallback_function_name(action, target)

        if action == "craft":
            program_code = f"""async function {function_name}(bot) {{
    const item = mcData.itemsByName["{target}"];
    if (!item) {{
        throw new Error("Unknown item: {target}");
    }}
    let previousCount = bot.inventory.count(item.id);
    while (bot.inventory.count(item.id) < {quantity}) {{
        bot.chat("Crafting {target}...");
        await craftItem(bot, "{target}", 1);
        const currentCount = bot.inventory.count(item.id);
        if (currentCount <= previousCount) {{
            throw new Error("Failed to craft more {target}");
        }}
        previousCount = currentCount;
    }}
}}"""
        elif action == "equip":
            slot = self._infer_equip_slot(target)
            if not slot:
                return None
            program_code = f"""async function {function_name}(bot) {{
    const item = bot.inventory.findInventoryItem(mcData.itemsByName["{target}"].id);
    if (!item) {{
        throw new Error("Missing item to equip: {target}");
    }}
    await bot.equip(item, "{slot}");
}}"""
        else:
            return None

        return {
            "program_code": program_code,
            "program_name": function_name,
            "exec_code": f"await {function_name}(bot);",
        }

    def _extract_code_from_message(self, content):
        if "</think>" in content:
            content = content.split("</think>", 1)[1]

        js_fences = re.findall(
            r"```(?:javascript|js)\s*(.*?)```", content, flags=re.DOTALL | re.IGNORECASE
        )
        if js_fences:
            return js_fences[-1].strip()

        generic_fences = re.findall(r"```\s*(.*?)```", content, flags=re.DOTALL)
        if generic_fences:
            return generic_fences[-1].strip()

        async_function_index = content.find("async function")
        if async_function_index >= 0:
            return content[async_function_index:].strip()

        function_index = content.find("function")
        if function_index >= 0:
            return content[function_index:].strip()

        return content.strip()

    def format_ai_message_for_log(self, content):
        extracted = self._extract_code_from_message(content)
        if extracted and extracted != content.strip():
            return extracted
        if "</think>" in content:
            return content.split("</think>", 1)[1].strip()
        return content.strip()

    def _parse_simple_task(self, task):
        match = re.match(
            r"^\s*(Craft|Equip)\s+(?:(\d+|a|an|one)\s+)?(.+?)\s*$",
            task,
            re.IGNORECASE,
        )
        if not match:
            return None

        action = match.group(1).lower()
        quantity_token = (match.group(2) or "1").lower()
        target = match.group(3).strip().rstrip(".")

        quantity_map = {"a": 1, "an": 1, "one": 1}
        quantity = quantity_map.get(quantity_token)
        if quantity is None:
            quantity = int(quantity_token)

        target = target.replace(" ", "_").lower()
        return {"action": action, "quantity": quantity, "target": target}

    def _fallback_function_name(self, action, target):
        parts = [part for part in re.split(r"[_\W]+", target) if part]
        suffix = "".join(part.capitalize() for part in parts) or "Task"
        return f"{action}{suffix}Fallback"

    def _infer_equip_slot(self, target):
        slot_map = {
            "shield": "off-hand",
            "helmet": "head",
            "chestplate": "torso",
            "leggings": "legs",
            "boots": "feet",
        }
        for key, slot in slot_map.items():
            if key in target:
                return slot
        if any(
            tool in target
            for tool in ["sword", "pickaxe", "axe", "shovel", "hoe", "bow"]
        ):
            return "hand"
        return None

    def _prepare_code_for_parse(self, code):
        function_blocks = self._extract_function_blocks(code)
        if not function_blocks:
            return code.strip()

        deduped_blocks = []
        seen_names = set()
        for block in reversed(function_blocks):
            if block["name"] in seen_names:
                continue
            seen_names.add(block["name"])
            deduped_blocks.append(block["code"])
        deduped_blocks.reverse()
        return "\n\n".join(deduped_blocks).strip()

    def _extract_function_blocks(self, code):
        pattern = re.compile(
            r"(?m)^(async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\("
        )
        matches = list(pattern.finditer(code))
        if not matches:
            return []

        blocks = []
        for match in matches:
            start = match.start()
            name = match.group(2)
            block = self._slice_function_block(code, start)
            if block:
                blocks.append({"name": name, "code": block.strip()})
        return blocks

    def _slice_function_block(self, code, start):
        brace_start = code.find("{", start)
        if brace_start < 0:
            return ""

        depth = 0
        in_single = False
        in_double = False
        in_template = False
        in_line_comment = False
        in_block_comment = False
        escaped = False

        for index in range(brace_start, len(code)):
            char = code[index]
            next_char = code[index + 1] if index + 1 < len(code) else ""

            if in_line_comment:
                if char == "\n":
                    in_line_comment = False
                continue
            if in_block_comment:
                if char == "*" and next_char == "/":
                    in_block_comment = False
                continue
            if escaped:
                escaped = False
                continue
            if char == "\\" and (in_single or in_double or in_template):
                escaped = True
                continue
            if not (in_single or in_double or in_template):
                if char == "/" and next_char == "/":
                    in_line_comment = True
                    continue
                if char == "/" and next_char == "*":
                    in_block_comment = True
                    continue
            if char == "'" and not (in_double or in_template):
                in_single = not in_single
                continue
            if char == '"' and not (in_single or in_template):
                in_double = not in_double
                continue
            if char == "`" and not (in_single or in_double):
                in_template = not in_template
                continue
            if in_single or in_double or in_template:
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return code[start : index + 1]
        return code[start:].strip()

    def summarize_chatlog(self, events):
        def filter_item(message: str):
            craft_pattern = r"I cannot make \w+ because I need: (.*)"
            craft_pattern2 = (
                r"I cannot make \w+ because there is no crafting table nearby"
            )
            mine_pattern = r"I need at least a (.*) to mine \w+!"
            if re.match(craft_pattern, message):
                return re.match(craft_pattern, message).groups()[0]
            elif re.match(craft_pattern2, message):
                return "a nearby crafting table"
            elif re.match(mine_pattern, message):
                return re.match(mine_pattern, message).groups()[0]
            else:
                return ""

        chatlog = set()
        for event_type, event in events:
            if event_type == "onChat":
                item = filter_item(event["onChat"])
                if item:
                    chatlog.add(item)
        return "I also need " + ", ".join(chatlog) + "." if chatlog else ""
