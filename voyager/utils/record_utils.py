import hashlib
import os
import re
import time

from .file_utils import *
from .json_utils import *


class EventRecorder:
    def __init__(
        self,
        ckpt_dir="ckpt",
        resume=False,
        init_position=None,
    ):
        self.ckpt_dir = ckpt_dir
        self.item_history = set()
        self.item_vs_time = {}
        self.item_vs_iter = {}
        self.biome_history = set()
        self.init_position = init_position
        self.position_history = [[0, 0]]
        self.elapsed_time = 0
        self.iteration = 0
        self.max_task_filename_len = max(
            32, int(os.getenv("VOYAGER_EVENT_TASK_FILENAME_MAX", "120"))
        )
        f_mkdir(self.ckpt_dir, "events")
        if resume:
            self.resume()

    def record(self, events, task):
        task = re.sub(r'[\\/:"*?<>| ]', "_", task or "")
        task = task.replace(" ", "_").strip("_") or "task"
        timestamp = time.strftime("_%Y%m%d_%H%M%S", time.localtime())
        max_task_len = max(8, self.max_task_filename_len - len(timestamp))
        if len(task) > max_task_len:
            digest = hashlib.sha1(task.encode("utf-8")).hexdigest()[:8]
            prefix_len = max(1, max_task_len - len(digest) - 1)
            task = f"{task[:prefix_len]}_{digest}"
        task = f"{task}{timestamp}"
        self.iteration += 1
        if not self.init_position:
            self.init_position = [
                events[0][1]["status"]["position"]["x"],
                events[0][1]["status"]["position"]["z"],
            ]
        for event_type, event in events:
            self.update_items(event)
            if event_type == "observe":
                self.update_elapsed_time(event)
        print(
            f"\033[96m****Recorder message: {self.elapsed_time} ticks have elapsed****\033[0m\n"
            f"\033[96m****Recorder message: {self.iteration} iteration passed****\033[0m"
        )
        dump_json(events, f_join(self.ckpt_dir, "events", task))

    def resume(self, cutoff=None):
        self.item_history = set()
        self.item_vs_time = {}
        self.item_vs_iter = {}
        self.elapsed_time = 0
        self.position_history = [[0, 0]]

        def get_timestamp(string):
            timestamp = "_".join(string.split("_")[-2:])
            return time.mktime(time.strptime(timestamp, "%Y%m%d_%H%M%S"))

        records = f_listdir(self.ckpt_dir, "events")
        sorted_records = sorted(records, key=get_timestamp)
        for record in sorted_records:
            self.iteration += 1
            if cutoff and self.iteration > cutoff:
                break
            events = load_json(f_join(self.ckpt_dir, "events", record))
            if not self.init_position:
                self.init_position = (
                    events[0][1]["status"]["position"]["x"],
                    events[0][1]["status"]["position"]["z"],
                )
            for event_type, event in events:
                self.update_items(event)
                self.update_position(event)
                if event_type == "observe":
                    self.update_elapsed_time(event)

    def update_items(self, event):
        inventory = event["inventory"]
        elapsed_time = event["status"]["elapsedTime"]
        biome = event["status"]["biome"]
        items = set(inventory.keys())
        new_items = items - self.item_history
        self.item_history.update(items)
        self.biome_history.add(biome)
        if new_items:
            if self.elapsed_time + elapsed_time not in self.item_vs_time:
                self.item_vs_time[self.elapsed_time + elapsed_time] = []
            self.item_vs_time[self.elapsed_time + elapsed_time].extend(new_items)
            if self.iteration not in self.item_vs_iter:
                self.item_vs_iter[self.iteration] = []
            self.item_vs_iter[self.iteration].extend(new_items)

    def update_elapsed_time(self, event):
        self.elapsed_time += event["status"]["elapsedTime"]

    def update_position(self, event):
        position = [
            event["status"]["position"]["x"] - self.init_position[0],
            event["status"]["position"]["z"] - self.init_position[1],
        ]
        if self.position_history[-1] != position:
            self.position_history.append(position)
