# 测试模型能力配置（data/model_extern_config.json）能否被正确读取并附加到 /v1/models 返回值。
#
# 默认无预置配置：data 目录下没有该文件时，生成一个空的 "{}"，由用户在页面自行添加。
# 覆盖：
#   1. 运行时 data 目录缺失文件时，生成空配置（而非默认预置内容）。
#   2. model_caps_for 的精确匹配 + 前缀匹配（含 q/glm-5.2 这类映射名）。
#   3. get_all_models 能按对外暴露的模型 id 附加 context_window/max_output_tokens/supports_vision。
#
# 可直接运行：python test/test_model_extern_config.py
# 也可作为 pytest 用例：pytest test/test_model_extern_config.py

import json
import sys
from pathlib import Path

# 允许直接以脚本方式运行（pytest 下 conftest 也做了同样处理）。
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import pytest

from uni_api.api import models


# 模块级缓存需要在测试内重建，避免其它用例/加载顺序影响前缀表。
def _install_caps(monkeypatch, caps):
    monkeypatch.setattr(models, "_MODEL_CAPS", caps)
    monkeypatch.setattr(models, "_MODEL_CAPS_PREFIXES", sorted(caps, key=len, reverse=True))


def test_runtime_file_generated_empty_when_missing(monkeypatch, tmp_path):
    runtime = tmp_path / "data" / "model_extern_config.json"
    monkeypatch.setenv("UNI_API_MODEL_CONTEXT_PATH", str(runtime))

    caps = models._load_model_extern_config()

    assert caps == {}
    assert runtime.exists(), "运行时 data 目录下没有文件时应自动生成"
    assert json.loads(runtime.read_text(encoding="utf-8")) == {}


def test_model_caps_for_exact_and_prefix(monkeypatch):
    caps = {
        "q/glm-5.2": {"context_window": 200000, "max_output_tokens": 8192, "supports_vision": False},
        "glm": {"context_window": 128000, "max_output_tokens": 4096, "supports_vision": False},
        "gpt-4o": {"context_window": 128000, "max_output_tokens": 16384, "supports_vision": True},
    }
    _install_caps(monkeypatch, caps)

    # 精确匹配含 "/" 的映射名
    assert models.model_caps_for("q/glm-5.2") == caps["q/glm-5.2"]
    assert models.model_caps_for("gpt-4o") == caps["gpt-4o"]
    # 前缀兜底：glm-4 命中 "glm"
    assert models.model_caps_for("glm-4") == caps["glm"]
    # 无匹配
    assert models.model_caps_for("unknown-model") is None


def test_get_all_models_attaches_caps_by_exposed_id(monkeypatch):
    caps = {
        "q/glm-5.2": {"context_window": 200000, "max_output_tokens": 8192, "supports_vision": False},
    }
    _install_caps(monkeypatch, caps)

    # provider 用 dict 映射：真实模型 glm-5.2 -> 对外暴露 q/glm-5.2
    config = {"providers": [{"provider": "q", "model": [{"glm-5.2": "q/glm-5.2"}]}]}
    result = models.get_all_models(config)

    assert len(result) == 1
    model = result[0]
    assert model["id"] == "q/glm-5.2"
    assert model["context_window"] == 200000
    assert model["max_output_tokens"] == 8192
    assert model["supports_vision"] is False


def test_get_all_models_unknown_model_returns_null_caps(monkeypatch):
    _install_caps(monkeypatch, {})
    config = {"providers": [{"provider": "q", "model": ["glm-5.2"]}]}
    result = models.get_all_models(config)

    assert len(result) == 1
    model = result[0]
    assert model["id"] == "glm-5.2"
    assert model["context_window"] is None
    assert model["max_output_tokens"] is None
    assert model["supports_vision"] is None


if __name__ == "__main__":
    # 作为独立脚本直接运行时的自检：默认无预置配置，返回空配置。
    caps = models._load_model_extern_config()
    print(f"默认加载到 {len(caps)} 条配置（默认无预置，应为 0）")

    print(f"model_caps_for('unknown-model') = {models.model_caps_for('unknown-model')}")

    config = {"providers": [{"provider": "q", "model": [{"glm-5.2": "q/glm-5.2"}]}]}
    for row in models.get_all_models(config):
        print("get_all_models (未配置能力时三项应为 None) ->", row)