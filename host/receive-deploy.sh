#!/usr/bin/env bash
# Runs the deploy key's command from SSH_ORIGINAL_COMMAND: an upload into the uploads folder through rrsync, or
# `activate <version>`, which copies an upload into the releases folder, checks it and switches the site to it.
# Usage in ~/.ssh/authorized_keys: restrict,command="receive-deploy <web folder> <host's copy of htaccess>" <key>
set -euo pipefail

web=$1
htaccess=$2
uploads=$web/uploads
releases=$web/releases
version='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
kept_count=3

fail() {
    echo "$1" >&2
    exit 1
}

# copies the upload into a new folder and removes the upload before the checks, because a running rsync keeps writing
# into the folder that it changed into, also after a rename
take_upload() {
    local tag=$1
    if [[ -L $uploads/$tag ]]; then
        fail "The release $tag is a link."
    fi
    if [[ ! -d $uploads/$tag ]]; then
        return
    fi
    # drops an upload of the live release that has the same files, because a deploy that runs again uploads the release
    # again and the live release keeps the balance that the host's timer writes
    if [[ $(readlink "$web/html" || true) == "releases/$tag" ]]; then
        if ! diff -rq --no-dereference -x balance.json -- "$uploads/$tag" "$releases/$tag" > /dev/null; then
            fail "The release $tag is live. Upload a new version."
        fi

        rm -rf -- "${uploads:?}/$tag"
        return
    fi

    rm -rf -- "${releases:?}/$tag"
    cp -rT -- "$uploads/$tag" "$releases/$tag"
    rm -rf -- "${uploads:?}/$tag"
}

# refuses a release with a link or a file that the host could run, because the site only has static files
check_release() {
    local tag=$1
    local release=$releases/$tag
    local found
    if [[ -L $release || ! -f $release/index.html || -L $release/index.html ]]; then
        fail "The release $tag isn't uploaded."
    fi

    found=$(find "$release" -type l -printf '%P\n' | head -n 1)
    if [[ -n $found ]]; then
        fail "The release $tag has a link: $found."
    fi

    found=$(find "$release" -mindepth 1 \( -path "$release/*/.htaccess" -o -name .user.ini \
        -o -iregex '.*\.\(php[3-8]?\|phtml\|phar\|pht\|cgi\|pl\|py\|sh\|shtml\|inc\)' \) -printf '%P\n' | head -n 1)
    if [[ -n $found ]]; then
        fail "The release $tag has a file that the host could run: $found."
    fi

    if ! cmp -s "$release/.htaccess" "$htaccess"; then
        fail "The release $tag's .htaccess differs from the host's copy."
    fi
}

# copies the live release's balance into the new release because only the host's timer writes it
copy_balance() {
    local release=$releases/$1
    local live=$web/html/balance.json
    local new
    if [[ ! -f $live || -L $live || $live -ef $release/balance.json ]]; then
        return
    fi

    # writes a new file and renames it over the old balance, so the copy never writes through a link
    new=$(mktemp "$release/.balance.json.XXXXXX")
    cat "$live" > "$new"
    chmod 644 "$new"
    mv -fT "$new" "$release/balance.json"
}

activate() {
    local tag=$1
    if [[ ! $tag =~ $version ]]; then
        fail "$tag isn't a version like 1.0.0."
    fi

    take_upload "$tag"
    check_release "$tag"
    copy_balance "$tag"

    # renames a new link over the old one because the site then always has a folder
    ln -sfn "releases/$tag" "$web/html.new"
    mv -T "$web/html.new" "$web/html"

    # removes the oldest releases, but never the live release
    local name
    for name in $(find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$version" | sort -V | head -n -$kept_count); do
        if [[ $name != "$tag" ]]; then
            rm -rf -- "${releases:?}/$name"
        fi
    done
}

case ${SSH_ORIGINAL_COMMAND:-} in
    'rsync --server '*)
        exec rrsync -wo -munge "$uploads"
        ;;
    'activate '*)
        activate "${SSH_ORIGINAL_COMMAND#activate }"
        ;;
    *)
        fail 'This key only uploads a release and activates it.'
        ;;
esac
