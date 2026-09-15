#!/usr/bin/env bash
set -Eeuo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir"

log() { printf '\n==> %s\n' "$1"; }
fail() { printf '错误：%s\n' "$1" >&2; exit 1; }

if [[ $(id -u) -eq 0 ]]; then
  root_run=()
else
  command -v sudo >/dev/null 2>&1 || fail '当前用户不是 root，并且系统没有 sudo。'
  root_run=(sudo)
fi

install_docker() {
  if command -v docker >/dev/null 2>&1 && "${root_run[@]}" docker compose version >/dev/null 2>&1; then
    return
  fi
  command -v apt-get >/dev/null 2>&1 || fail '自动安装目前只支持 Ubuntu/Debian；请先手动安装 Docker。'
  log '安装 Docker 和必要工具'
  "${root_run[@]}" apt-get update
  "${root_run[@]}" apt-get install -y ca-certificates curl
  installer=$(mktemp /tmp/lx-melobridge-docker-install.XXXXXX)
  curl -fsSL https://get.docker.com -o "$installer"
  "${root_run[@]}" sh "$installer"
  rm -f "$installer"
  "${root_run[@]}" systemctl enable --now docker
  "${root_run[@]}" docker compose version >/dev/null
}

prompt_default() {
  local variable_name=$1
  local prompt=$2
  local default_value=$3
  local current_value=${!variable_name:-}
  if [[ -z $current_value ]]; then
    read -r -p "$prompt [$default_value]: " current_value
    current_value=${current_value:-$default_value}
  fi
  printf -v "$variable_name" '%s' "$current_value"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

log '填写安装信息'
public_host=${PUBLIC_HOST:-}
while [[ -z $public_host ]]; do
  read -r -p '请输入公网 IP 或域名（不要带 https://）: ' public_host
done
[[ $public_host != *://* && $public_host != */* && $public_host != *:* && $public_host != *' '* ]] \
  || fail 'PUBLIC_HOST 只能填写域名或 IPv4，不能带协议、端口、路径或空格。'

source_file=${SOURCE_FILE:-}
while [[ -z $source_file ]]; do
  read -r -p '请输入已经上传到服务器的洛雪 .js 文件完整路径: ' source_file
done
[[ -f $source_file ]] || fail "找不到音源文件：$source_file"
[[ ${source_file,,} == *.js ]] || fail '音源文件必须以 .js 结尾。'

gateway_user=${GATEWAY_USER:-}
admin_user=${ADMIN_USER:-}
prompt_default gateway_user '请输入手机播放器登录用户名' 'music'
prompt_default admin_user '请输入音源管理页登录用户名' 'admin'
[[ $gateway_user =~ ^[A-Za-z0-9._-]+$ ]] || fail '播放器用户名只能包含字母、数字、点、下划线和短横线。'
[[ $admin_user =~ ^[A-Za-z0-9._-]+$ ]] || fail '管理员用户名只能包含字母、数字、点、下划线和短横线。'

if [[ -f .env && ${FORCE_INSTALL:-false} != true ]]; then
  fail '当前目录已经存在 .env。为避免覆盖现有密码，安装脚本已停止。更新版本不需要重新运行安装脚本。'
fi

install_docker

log '准备目录和音源'
mkdir -p sources data runner-data
source_name=$(basename -- "$source_file")
source_target="$project_dir/sources/$source_name"
if [[ $(readlink -f -- "$source_file") != $(readlink -m -- "$source_target") ]]; then
  cp -- "$source_file" "$source_target"
fi
chmod 644 "$source_target"

app_user=${SUDO_USER:-$(id -un)}
if [[ $app_user == root ]]; then
  if ! id lxmelobridge >/dev/null 2>&1; then
    "${root_run[@]}" useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin lxmelobridge
  fi
  app_user=lxmelobridge
fi
app_uid=$(id -u "$app_user")
app_gid=$(id -g "$app_user")
"${root_run[@]}" chown -R "$app_uid:$app_gid" data runner-data
chmod 700 data runner-data

gateway_password=${GATEWAY_PASSWORD:-$(random_secret)}
admin_password=${ADMIN_PASSWORD:-$(random_secret)}
resolver_token=${RESOLVER_TOKEN:-$(random_secret)}

log '生成配置'
umask 077
cat > .env <<EOF
PUBLIC_HOST=$public_host
GATEWAY_USER=$gateway_user
GATEWAY_PASSWORD=$gateway_password
ADMIN_USER=$admin_user
ADMIN_PASSWORD=$admin_password
RESOLVER_TOKEN=$resolver_token
ACTIVE_SOURCE=$source_name
AUTO_SCRIPT_FALLBACK=false
FALLBACK_SOURCES=
SOURCE_ATTEMPT_TIMEOUT_MS=20000
APP_UID=$app_uid
APP_GID=$app_gid
EOF
chmod 600 .env

log '检查并启动容器'
"${root_run[@]}" docker compose --env-file .env -f compose.cloud.yaml config --quiet
"${root_run[@]}" docker compose --env-file .env -f compose.cloud.yaml up -d
"${root_run[@]}" docker compose --env-file .env -f compose.cloud.yaml ps

log '安装完成'
cat <<EOF

手机服务器地址：https://$public_host
播放器用户名：$gateway_user
播放器密码：$gateway_password

音源管理地址：https://$public_host/source-admin/
管理页用户名：$admin_user
管理页密码：$admin_password

请立即把上面的账号和密码保存到自己的密码管理器中。
第一次启动需要下载镜像并申请 HTTPS 证书，网页可能要等待一至三分钟。
健康检查：https://$public_host/healthz
EOF
