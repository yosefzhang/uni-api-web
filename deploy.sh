#!/usr/bin/env bash
# deploy.sh - uni-api-web 本地开发部署脚本
# 用法:
#   ./deploy.sh dev      启动前后端开发服务
#   ./deploy.sh stop     停止前后端服务
#   ./deploy.sh restart  重启前后端服务
#   ./deploy.sh status   查看运行状态

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBUI_DIR="$PROJECT_ROOT/webui"
BACKEND_PIDFILE="$PROJECT_ROOT/.run/backend.pid"
FRONTEND_PIDFILE="$PROJECT_ROOT/.run/frontend.pid"
BACKEND_PORT="${PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-19212}"
PROXY="${PROXY:-http://127.0.0.1:9132}"

mkdir -p "$PROJECT_ROOT/.run"

# 通过端口查找所有监听进程 PID（兼容 ss / netstat / lsof）
# 注意：grep 无匹配时返回 1，配合 set -euo pipefail 会静默退出，故末尾统一 || true
port_pids() {
  local port="$1"
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep ":${port}" | grep -oP 'pid=\K[0-9]+' | sort -u || true
  elif command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | grep ":${port}" | grep -oP 'PID/\K[0-9]+' | sort -u || true
  elif command -v lsof &>/dev/null; then
    lsof -ti :"$port" 2>/dev/null | sort -u || true
  fi
}

# 第一个 PID（用于显示）
port_first_pid() {
  port_pids "$1" | head -1
}

# 检测端口是否被监听
port_listening() {
  [ -n "$(port_first_pid "$1")" ]
}

# 综合判断服务是否在运行：端口在监听即认为运行中
is_running() {
  port_listening "$1"
}

stop_service() {
  local name="$1" port="$2" pidfile="$3"
  local killed_any=false

  # 循环杀，直到端口释放（处理 --reload 下的多进程残留）
  for round in $(seq 1 5); do
    local pids=""
    # 1) 端口上的所有进程
    pids="$(port_pids "$port")"
    # 2) PID 文件记录的父进程及其子进程
    if [ -f "$pidfile" ]; then
      local file_pid
      file_pid="$(cat "$pidfile" 2>/dev/null || true)"
      if [ -n "$file_pid" ]; then
        local children
        children="$(pgrep -P "$file_pid" 2>/dev/null || true)"
        for p in "$file_pid" $children; do
          case " $pids " in
            *" $p "*) ;;
            *) pids="$pids $p" ;;
          esac
        done
      fi
    fi

    pids="$(echo $pids | tr -s ' ' | sed 's/^ //;s/ $//')"
    [ -z "$pids" ] && break

    [ "$round" = "1" ] && echo "停止 $name (PID: $pids) ..."
    killed_any=true

    for pid in $pids; do
      kill "$pid" 2>/dev/null || true
    done
    # 等待退出
    for _ in $(seq 1 10); do
      local still=""
      for pid in $pids; do
        kill -0 "$pid" 2>/dev/null && still="$still $pid"
      done
      [ -z "$still" ] && break
      sleep 0.3
    done
    # 强杀残留
    for pid in $pids; do
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    done
    sleep 0.3
  done

  if $killed_any; then
    echo "$name 已停止"
  else
    echo "$name 未在运行"
  fi
  rm -f "$pidfile"
}

start_backend() {
  if is_running "$BACKEND_PORT"; then
    echo "后端已在运行 (端口 $BACKEND_PORT, PID $(port_first_pid "$BACKEND_PORT"))"
    return
  fi
  echo "启动后端 (端口 $BACKEND_PORT) ..."
  cd "$PROJECT_ROOT"
  nohup .venv/bin/uvicorn uni_api.runtime:app \
    --host 0.0.0.0 --port "$BACKEND_PORT" \
    --reload --reload-dir . \
    --reload-exclude '.venv/*' \
    --reload-exclude 'webui/node_modules/*' \
    --reload-exclude 'data/*' \
    > "$PROJECT_ROOT/.run/backend.log" 2>&1 &
  echo $! > "$BACKEND_PIDFILE"
  echo "后端已启动 (PID $!)"
}

start_frontend() {
  if is_running "$FRONTEND_PORT"; then
    echo "前端已在运行 (端口 $FRONTEND_PORT, PID $(port_first_pid "$FRONTEND_PORT"))"
    return
  fi
  echo "启动前端 (端口 $FRONTEND_PORT) ..."
  cd "$WEBUI_DIR"
  # 直接调用 next，绕过 pnpm dev 在非 TTY 环境下的依赖重建检查
  nohup ./node_modules/.bin/next dev -p "$FRONTEND_PORT" \
    > "$PROJECT_ROOT/.run/frontend.log" 2>&1 &
  echo $! > "$FRONTEND_PIDFILE"
  echo "前端已启动 (PID $!)"
}

show_status() {
  local name="$1" port="$2" pidfile="$3"
  local pids file_pid
  pids="$(port_pids "$port" | tr '\n' ' ' | sed 's/ $//')"
  file_pid="$(cat "$pidfile" 2>/dev/null || true)"

  if [ -n "$pids" ]; then
    echo "  $name: 运行中 (端口 $port, PID $pids)"
  elif [ -n "$file_pid" ] && kill -0 "$file_pid" 2>/dev/null; then
    echo "  $name: 进程存活但端口 $port 未监听 (PID $file_pid, 可能仍在启动中)"
  else
    echo "  $name: 未运行"
  fi
}

case "${1:-}" in
  dev)
    start_backend
    start_frontend
    echo ""
    echo "前端: http://localhost:$FRONTEND_PORT"
    echo "后端: http://localhost:$BACKEND_PORT"
    echo "日志: $PROJECT_ROOT/.run/{backend,frontend}.log"
    ;;
  stop)
    stop_service "前端" "$FRONTEND_PORT" "$FRONTEND_PIDFILE"
    stop_service "后端" "$BACKEND_PORT" "$BACKEND_PIDFILE"
    ;;
  restart)
    stop_service "前端" "$FRONTEND_PORT" "$FRONTEND_PIDFILE"
    stop_service "后端" "$BACKEND_PORT" "$BACKEND_PIDFILE"
    sleep 1
    start_backend
    start_frontend
    echo ""
    echo "前端: http://localhost:$FRONTEND_PORT"
    echo "后端: http://localhost:$BACKEND_PORT"
    echo "日志: $PROJECT_ROOT/.run/{backend,frontend}.log"
    ;;
  status)
    echo "服务状态:"
    show_status "后端" "$BACKEND_PORT" "$BACKEND_PIDFILE"
    show_status "前端" "$FRONTEND_PORT" "$FRONTEND_PIDFILE"
    ;;
  *)
    echo "用法: $0 {dev|stop|restart|status}"
    exit 1
    ;;
esac
