from voyager.prompts import load_prompt
from voyager.utils.json_utils import fix_and_parse_json
from langchain.schema import HumanMessage, SystemMessage
from voyager.llms import CerebrasChatModel
import re


class CriticAgent:
    def __init__(
        self,
        model_name="MBZUAI-IFM/K2-Think-v2",
        temperature=0,
        request_timout=120,
        mode="auto",
    ):
        self.llm = CerebrasChatModel(
            model_name=model_name,
            temperature=temperature,
            request_timeout=request_timout,
        )
        assert mode in ["auto", "manual"]
        self.mode = mode

    def render_system_message(self):
        system_message = SystemMessage(content=load_prompt("critic"))
        return system_message

    def render_human_message(self, *, events, task, context, chest_observation):
        assert events[-1][0] == "observe", "Last event must be observe"
        biome = events[-1][1]["status"]["biome"]
        time_of_day = events[-1][1]["status"]["timeOfDay"]
        voxels = events[-1][1]["voxels"]
        health = events[-1][1]["status"]["health"]
        hunger = events[-1][1]["status"]["food"]
        position = events[-1][1]["status"]["position"]
        equipment = events[-1][1]["status"]["equipment"]
        inventory_used = events[-1][1]["status"]["inventoryUsed"]
        inventory = events[-1][1]["inventory"]

        for i, (event_type, event) in enumerate(events):
            if event_type == "onError":
                print(f"\033[31mCritic Agent: Error occurs {event['onError']}\033[0m")
                return None

        observation = ""

        observation += f"Biome: {biome}\n\n"

        observation += f"Time: {time_of_day}\n\n"

        if voxels:
            observation += f"Nearby blocks: {', '.join(voxels)}\n\n"
        else:
            observation += f"Nearby blocks: None\n\n"

        observation += f"Health: {health:.1f}/20\n\n"
        observation += f"Hunger: {hunger:.1f}/20\n\n"

        observation += f"Position: x={position['x']:.1f}, y={position['y']:.1f}, z={position['z']:.1f}\n\n"

        observation += f"Equipment: {equipment}\n\n"

        if inventory:
            observation += f"Inventory ({inventory_used}/36): {inventory}\n\n"
        else:
            observation += f"Inventory ({inventory_used}/36): Empty\n\n"

        observation += chest_observation

        observation += f"Task: {task}\n\n"

        if context:
            observation += f"Context: {context}\n\n"
        else:
            observation += f"Context: None\n\n"

        print(f"\033[31m****Critic Agent human message****\n{observation}\033[0m")
        return HumanMessage(content=observation)

    def human_check_task_success(self):
        confirmed = False
        success = False
        critique = ""
        while not confirmed:
            success = input("Success? (y/n)")
            success = success.lower() == "y"
            critique = input("Enter your critique:")
            print(f"Success: {success}\nCritique: {critique}")
            confirmed = input("Confirm? (y/n)") in ["y", ""]
        return success, critique

    def ai_check_task_success(self, messages, max_retries=5):
        if max_retries == 0:
            print(
                "\033[31mFailed to parse Critic Agent response. Consider updating your prompt.\033[0m"
            )
            return False, ""

        if messages[1] is None:
            return False, ""

        critic = self.llm(messages).content
        print(
            f"\033[31m****Critic Agent ai message****\n"
            f"{self._format_critic_message_for_log(critic)}\033[0m"
        )
        try:
            response = self._parse_critic_response(critic)
            assert response["success"] in [True, False]
            if "critique" not in response:
                response["critique"] = ""
            return response["success"], response["critique"]
        except Exception as e:
            print(f"\033[31mError parsing critic response: {e} Trying again!\033[0m")
            return self.ai_check_task_success(
                messages=messages,
                max_retries=max_retries - 1,
            )

    def _extract_json_payload(self, content):
        if "</think>" in content:
            content = content.split("</think>", 1)[1]
        matches = re.findall(r"\{[\s\S]*\}", content)
        if matches:
            return matches[-1]
        return content

    def _parse_critic_response(self, content):
        try:
            return fix_and_parse_json(self._extract_json_payload(content))
        except Exception:
            lowered = content.lower()
            success = None
            if any(
                token in lowered
                for token in [
                    "success\": true",
                    "success: true",
                    "succeeded",
                    "successfully",
                    "completed the task",
                    "task is complete",
                ]
            ):
                success = True
            elif any(
                token in lowered
                for token in [
                    "success\": false",
                    "success: false",
                    "failed",
                    "didn't",
                    "did not",
                    "not enough",
                    "need to",
                ]
            ):
                success = False
            if success is None:
                raise
            return {
                "reasoning": content.strip(),
                "success": success,
                "critique": "" if success else content.strip(),
            }

    def _format_critic_message_for_log(self, content):
        if "</think>" in content:
            content = content.split("</think>", 1)[1]
        try:
            response = self._parse_critic_response(content)
            return (
                "{"
                f'"success": {str(response["success"]).lower()}, '
                f'"critique": "{response.get("critique", "")}"'
                "}"
            )
        except Exception:
            return content.strip()

    def _rule_based_check_task_success(self, events, task):
        inventory = events[-1][1]["inventory"]
        hunger = events[-1][1]["status"]["food"]
        equipment = events[-1][1]["status"]["equipment"]
        parsed = self._parse_simple_task(task)
        if not parsed:
            return None

        action = parsed["action"]
        quantity = parsed["quantity"]
        target = parsed["target"]

        if action in {"craft", "mine", "smelt", "cook"}:
            count = self._count_inventory_item(inventory, target)
            success = count >= quantity
            critique = "" if success else f"Need {quantity} {target}, but only have {count}."
            return success, critique
        if action == "equip":
            success = target in [item for item in equipment if item]
            critique = "" if success else f"Equip {target}."
            return success, critique
        if action == "eat":
            success = hunger >= 20
            critique = "" if success else f"Eat {target} until hunger is full."
            return success, critique
        return None

    def _parse_simple_task(self, task):
        match = re.match(
            r"^\s*(Craft|Mine|Smelt|Cook|Equip|Eat)\s+(?:(\d+|a|an|one)\s+)?(.+?)\s*$",
            task,
            re.IGNORECASE,
        )
        if not match:
            return None
        quantity_token = (match.group(2) or "1").lower()
        quantity = {"a": 1, "an": 1, "one": 1}.get(quantity_token)
        if quantity is None:
            quantity = int(quantity_token)
        return {
            "action": match.group(1).lower(),
            "quantity": quantity,
            "target": match.group(3).strip().rstrip(".").replace(" ", "_").lower(),
        }

    def _count_inventory_item(self, inventory, target):
        if target in inventory:
            return inventory[target]
        if target in {"wood_log", "wood_logs", "log", "logs"}:
            return sum(count for name, count in inventory.items() if name.endswith("_log"))
        ore_drops = {
            "iron_ore": "raw_iron",
            "gold_ore": "raw_gold",
            "copper_ore": "raw_copper",
            "coal_ore": "coal",
            "diamond_ore": "diamond",
            "redstone_ore": "redstone",
            "lapis_ore": "lapis_lazuli",
            "emerald_ore": "emerald",
        }
        drop = ore_drops.get(target)
        if drop and drop in inventory:
            return inventory[drop]
        return 0

    def check_task_success(
        self, *, events, task, context, chest_observation, max_retries=5
    ):
        rule_based = self._rule_based_check_task_success(events, task)
        if rule_based is not None:
            return rule_based

        human_message = self.render_human_message(
            events=events,
            task=task,
            context=context,
            chest_observation=chest_observation,
        )

        messages = [
            self.render_system_message(),
            human_message,
        ]

        if self.mode == "manual":
            return self.human_check_task_success()
        elif self.mode == "auto":
            return self.ai_check_task_success(
                messages=messages, max_retries=max_retries
            )
        else:
            raise ValueError(f"Invalid critic agent mode: {self.mode}")
