# uni-api-web

将 [uni-api](https://github.com/yym68686/uni-api)（后端，统一 LLM API 网关）与
[uni-api-status](https://github.com/melosbot/uni-api-status)（前端管理面板）整合到一起，
并在界面上做了一些改动。使用方法与 uni-api 保持一致。

uni-api-web 同时提供两部分能力：

- **API 网关**：一个 OpenAI 兼容接口，统一对接多种大模型提供商（OpenAI、Anthropic、
  Gemini、OpenRouter 等），支持负载均衡、自动重试、渠道冷却、限流等。
- **Web 管理面板**：用于查看请求统计、测试渠道、编辑配置的前端界面。

## 版本号

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| uni-api（后端） | `1.7.259` | `pyproject.toml` |
| uni-api-web（前端） | `0.1.0` | `webui/package.json` |

> 版本号会随发布更新，本地部署时可运行 `./deploy.sh status` 查看当前前后端版本。

## 管理面板功能

- 统计信息：概览、模型、渠道、详细日志
- 真实测试：测试某个渠道是否可用
- 配置管理（管理员）：编辑 `api.yaml`
- 在线配置（管理员）：在线修改配置

`api.yaml` 中 `api_keys` 里 `role: admin` 的 Key 拥有管理员权限，可访问「配置管理」
与「在线配置」页面。

## Docker Compose 部署

```yaml
services:
  uni-api-web:
    container_name: uni-api-web
    image: ghcr.io/yosefzhang/uni-api-web:latest
    network_mode: bridge
    restart: unless-stopped
    environment:
      - TZ=Asia/Shanghai
    ports:
      - "9210:8000"
    volumes:
      - ./api.yaml:/home/api.yaml
      - ./data:/home/data
```

启动：

```bash
docker compose up -d
```

- 容器内监听 `8000`，映射到宿主机 `9210`
- `api.yaml` 是配置文件（渠道与 API Key），`data` 是统计数据库目录

## 配置

最小可运行的 `api.yaml` 示例：

```yaml
providers:
  - provider: provider_name
    base_url: https://api.your.com/v1/chat/completions
    api: sk-xxxxxxxx

api_keys:
  - api: sk-user-key # 用户请求 uni-api 时使用的 Key
    role: admin      # admin 可访问管理面板的配置管理
```

配置项的详细说明请参考上游 [uni-api](https://github.com/yym68686/uni-api) 文档。

## 本地开发

```bash
./deploy.sh dev       # 启动前后端
./deploy.sh status    # 查看状态与版本号
./deploy.sh restart   # 重启
./deploy.sh stop      # 停止
```

- 后端：http://localhost:8000
- 前端：http://localhost:19212
- 日志：`.run/{backend,frontend}.log`

## 相关链接

- [uni-api](https://github.com/yym68686/uni-api)
- [uni-api-status](https://github.com/melosbot/uni-api-status)