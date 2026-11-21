#!/usr/bin/env bash
# Uploads the built site with host/htaccess into the tag's release folder on the host and switches the site to it.
# Usage: deploy.sh <tag> <site folder> <key file> <known hosts file>, with SSH_HOST and SSH_USER set
set -euo pipefail

tag=$1
site=$2
key=$3
known_hosts=$4

if [[ ! $tag =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "$tag isn't a version like 1.0.0." >&2
    exit 1
fi
if [[ ! -f $site/index.html ]]; then
    echo "$site doesn't have an index.html." >&2
    exit 1
fi

cp "$(dirname "$0")/../host/htaccess" "$site/.htaccess"

# offers only the deploy key and only talks to the host with the known key
ssh_options=(-i "$key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known_hosts")
# quotes each word of the command for rsync, which splits it at spaces and keeps quoted spaces but not backslashes
ssh_command=$(printf "'%s' " ssh "${ssh_options[@]}")
rsync -a --delete --delay-updates --chmod=D755,F644 -e "${ssh_command% }" "$site/" "$SSH_USER@$SSH_HOST:$tag/"
ssh "${ssh_options[@]}" "$SSH_USER@$SSH_HOST" "activate $tag"
