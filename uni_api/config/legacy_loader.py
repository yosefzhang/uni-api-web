from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx
from ruamel.yaml import YAML, YAMLError

from core.log_config import logger
from core.utils import (
    ThreadSafeCircularList,
    get_model_dict,
    provider_api_circular_list,
    safe_get,
    update_initial_model,
)
from uni_api.config.env import expand_config_environment
from uni_api.config.schema import validate_config_data


yaml = YAML()
yaml.preserve_quotes = True
yaml.indent(mapping=2, sequence=4, offset=2)

API_YAML_PATH = "./api.yaml"
yaml_error_message = None


def save_api_yaml(config_data: dict[str, Any], path: str | Path = API_YAML_PATH) -> None:
    with open(path, "w", encoding="utf-8") as file:
        yaml.dump(config_data, file)


async def update_config(config_data: dict[str, Any], use_config_url: bool = False):
    config_data = expand_config_environment(config_data)
    validate_config_data(config_data)
    config_data.setdefault("providers", [])
    config_data.setdefault("api_keys", [])
    
    # 先筛选出启用的 providers
    enabled_providers = []
    for provider in config_data["providers"]:
        if provider.get("enabled", True):
            enabled_providers.append(provider)
    config_data["providers"] = enabled_providers
    
    for index, provider in enumerate(config_data["providers"]):
        if provider.get("project_id"):
            if "google-vertex-ai" not in provider.get("base_url", ""):
                provider["base_url"] = "https://aiplatform.googleapis.com/"
        if provider.get("cf_account_id"):
            provider["base_url"] = "https://api.cloudflare.com/"

        if isinstance(provider["provider"], int):
            provider["provider"] = str(provider["provider"])

        provider_api = provider.get("api", None)
        if provider_api:
            # 处理 provider api，支持字符串、列表、对象或对象列表
            api_keys_list = []
            if isinstance(provider_api, int):
                api_keys_list = [str(provider_api)]
            elif isinstance(provider_api, str):
                api_keys_list = [provider_api]
            elif isinstance(provider_api, list):
                for key_item in provider_api:
                    if isinstance(key_item, str):
                        api_keys_list.append(key_item)
                    elif isinstance(key_item, dict):
                        if key_item.get("enabled", True):
                            key = key_item.get("key")
                            if key:
                                api_keys_list.append(key)
            elif isinstance(provider_api, dict):
                if provider_api.get("enabled", True):
                    key = provider_api.get("key")
                    if key:
                        api_keys_list = [key]
            
            if api_keys_list:
                provider_api_circular_list[provider["provider"]] = ThreadSafeCircularList(
                    items=api_keys_list,
                    rate_limit=safe_get(provider, "preferences", "api_key_rate_limit", default={"default": "999999/min"}),
                    schedule_algorithm=safe_get(provider, "preferences", "api_key_schedule_algorithm", default="round_robin"),
                    provider_name=provider["provider"],
                )

        if "models.inference.ai.azure.com" in provider["base_url"] and not provider.get("model"):
            provider["model"] = [
                "gpt-4o",
                "gpt-4.1",
                "gpt-4o-mini",
                "o4-mini",
                "o3",
                "text-embedding-3-small",
                "text-embedding-3-large",
            ]

        if not provider.get("model"):
            model_list = await update_initial_model(provider)
            if model_list:
                provider["model"] = model_list
                if not use_config_url:
                    save_api_yaml(config_data)

        if provider.get("tools") is None:
            provider["tools"] = True

        provider["_model_dict_cache"] = get_model_dict(provider)

        config_data["providers"][index] = provider

    # 筛选启用的 api_keys
    enabled_api_keys = []
    for api_key in config_data["api_keys"]:
        if api_key.get("enabled", True):
            enabled_api_keys.append(api_key)
    config_data["api_keys"] = enabled_api_keys
    
    for index, api_key in enumerate(config_data["api_keys"]):
        if "api" in api_key:
            config_data["api_keys"][index]["api"] = str(api_key["api"])

    api_keys_db = config_data["api_keys"]

    for index, api_key in enumerate(config_data["api_keys"]):
        weights_dict = {}
        models = []

        if "api" in api_key:
            config_data["api_keys"][index]["api"] = str(api_key["api"])

        if api_key.get("model"):
            for model in api_key.get("model"):
                if isinstance(model, dict):
                    key, value = list(model.items())[0]
                    provider_name = key.split("/")[0]
                    model_name = key.split("/")[1]

                    for provider_item in config_data["providers"]:
                        if provider_item["provider"] != provider_name:
                            continue
                        model_dict = get_model_dict(provider_item)
                        if model_name in model_dict.keys():
                            weights_dict.update({provider_name + "/" + model_name: int(value)})
                        elif model_name == "*":
                            weights_dict.update({provider_name + "/" + model_name: int(value) for model_item in model_dict.keys()})

                    models.append(key)
                if isinstance(model, str):
                    models.append(model)
            if weights_dict:
                config_data["api_keys"][index]["weights"] = weights_dict
            config_data["api_keys"][index]["model"] = models
            api_keys_db[index]["model"] = models
        else:
            config_data["api_keys"][index]["model"] = ["all"]
            api_keys_db[index]["model"] = ["all"]

    api_list = [item["api"] for item in api_keys_db]
    return config_data, api_keys_db, api_list


async def load_config(app=None):
    _ = app
    config: dict[str, Any]
    api_keys_db: list[dict[str, Any]] | dict
    api_list: list[str]
    try:
        with open(API_YAML_PATH, "r", encoding="utf-8") as file:
            conf = yaml.load(file)

        if conf:
            config, api_keys_db, api_list = await update_config(conf, use_config_url=False)
        else:
            logger.error("配置文件 'api.yaml' 为空。请检查文件内容。")
            config, api_keys_db, api_list = {}, {}, []
    except FileNotFoundError:
        if not os.environ.get("CONFIG_URL"):
            logger.error("'api.yaml' not found. Please check the file path.")
        config, api_keys_db, api_list = {}, {}, []
    except YAMLError as exc:
        logger.error("配置文件 'api.yaml' 格式不正确。请检查 YAML 格式。%s", exc)
        global yaml_error_message
        yaml_error_message = "配置文件 'api.yaml' 格式不正确。请检查 YAML 格式。"
        config, api_keys_db, api_list = {}, {}, []
    except OSError as exc:
        logger.error("open 'api.yaml' failed: %s", exc)
        config, api_keys_db, api_list = {}, {}, []

    if config != {}:
        return config, api_keys_db, api_list

    config_url = os.environ.get("CONFIG_URL")
    if config_url:
        try:
            default_config = {
                "headers": {
                    "User-Agent": "curl/7.68.0",
                    "Accept": "*/*",
                },
                "http2": True,
                "verify": True,
                "follow_redirects": True,
            }
            timeout = httpx.Timeout(connect=15.0, read=100, write=30.0, pool=200)
            client = httpx.AsyncClient(timeout=timeout, **default_config)
            try:
                response = await client.get(config_url)
                response.raise_for_status()
                config_data = yaml.load(response.text)
            finally:
                await client.aclose()
            if config_data:
                config, api_keys_db, api_list = await update_config(config_data, use_config_url=True)
            else:
                logger.error("Error fetching or parsing config from %s", config_url)
                config, api_keys_db, api_list = {}, {}, []
        except Exception as exc:
            logger.error("Error fetching or parsing config from %s: %s", config_url, str(exc))
            config, api_keys_db, api_list = {}, {}, []
    return config, api_keys_db, api_list
