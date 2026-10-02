#!/usr/bin/env bash
#
# Who decodes unicode escapes in written content a second time?
#
# Writes ONE payload through the three routes an agent can write through, with
# raw JSON-RPC / JSON request bodies sent by curl — no AI client takes part in
# building them — and reads the stored file back AS BYTES after each:
#
#   1. the tool route     POST /api/agent/tools/write_file
#   2. the MCP endpoint    POST /api/mcp          (JSON-RPC `tools/call`)
#   3. call_tool_chain     POST /api/mcp          (content as a JavaScript
#                                                  string literal in the code)
#
# The payload is `A|\"|\\|\n|—` AS TEXT: an escape for a letter, for a
# quote, for a backslash and for a line break, each meant to stay the
# characters it is written with, plus a real em dash meant to stay an em dash.
# 17 characters, 19 bytes. The question each read answers is whether the stored
# bytes are the six characters backslash, u, 0, 0, 4, 1 — or the single letter
# `A`.
#
# Every request body is written to a file first and dumped with `od -c`, so the
# evidence shows what went on the wire, not what this script meant to send.
#
# Usage:
#   BASE=http://hx-slug-app-1:3001 \
#   KEY=<connection key or internal bearer> \
#   JWT=<signed-in user token, for the byte-level read> \
#   BRANCH=<branch> \
#   scripts/repro-escape-sequences.sh
#
# JWT is optional: without it the byte-level read falls back to the raw text of
# the `read_file` answer, which carries the stored content still JSON-escaped
# (`\\u0041` there means the six characters are on disk).

set -euo pipefail

BASE=${BASE:?set BASE, e.g. http://hx-slug-app-1:3001}
KEY=${KEY:?set KEY to a connection key or internal bearer}
BRANCH=${BRANCH:?set BRANCH to the branch to write on}
DIR=${DIR:-knowledge-base/escape-repro-$$}
JWT=${JWT:-}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
WSID=$(printf '%s' "$BRANCH" | sed 's/\//%2F/g')

# ── the three request bodies, literal — a quoted heredoc interprets nothing ──

cat > "$WORK/1-tool-route.tmpl" <<'EOF'
{"branch":"__BRANCH__","path":"__DIR__/route-tool.md","content":"\\u0041|\\\"|\\\\|\\n|—"}
EOF

cat > "$WORK/2-mcp.tmpl" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_file","arguments":{"body":{"branch":"__BRANCH__","path":"__DIR__/route-mcp.md","content":"\\u0041|\\\"|\\\\|\\n|—"}}}}
EOF

# The chain's `code` is itself a JSON string, so the JS string literal inside it
# is escaped twice: `\\\\u0041` on the wire is `\\u0041` in the JavaScript
# source, which is the six characters at runtime.
cat > "$WORK/3-chain.tmpl" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"call_tool_chain","arguments":{"code":"return KNOWLEDGE_BASE.write_file({ body: { branch: \"__BRANCH_JS__\", path: \"__DIR_JS__/route-chain.md\", content: \"\\\\u0041|\\\\\\\"|\\\\\\\\|\\\\n|—\" } });"}}}
EOF

# Escapes a value for use as the CONTENTS of a JSON string (no quotes added).
json_esc() { # json_esc <value>
  local v=$1
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  printf '%s' "$v"
}

json_str() { # json_str <value> — the value as a complete JSON string
  printf '"%s"' "$(json_esc "$1")"
}

# Substitutes with bash's own string operators rather than with sed, which
# expands `&` in a replacement to the whole match — and `&` is legal in a git
# branch name, so a branch `a&b` used to render as `a__BRANCH__b`. Escaping
# sed's metacharacters (`&`, `\\`, the `|` delimiter) is strictly harder than not
# interpreting them, and this also sidesteps `sed -i`, whose no-suffix form is
# GNU-only and whose `-i ''` form is BSD-only.
#
# Every placeholder sits inside a JSON string, so the value is JSON-escaped: git
# forbids a backslash in a ref but allows a quote, and an unescaped quote would
# make the body malformed rather than merely wrong. In the chain template the
# value sits inside a JavaScript string literal that is ITSELF inside a JSON
# string, so there it is escaped twice — hence the `_JS` placeholders.
#
# ONE pass, left to right: a substituted value is copied to the output and never
# looked at again. Four sequential `${text//…}` replacements would each re-scan
# what the previous one inserted, so a branch legally named `feature__DIR__docs`
# would have its own text rewritten by the `__DIR__` round and the script would
# write to a branch nobody asked for.
render() { # render <template> <output>
  local text out pre len token best_token best_len
  text=$(cat "$1")
  out=

  while :; do
    best_token=
    best_len=
    # The earliest placeholder still ahead of us wins. No two of these can match
    # at the same position (`__BRANCH_JS__` and `__BRANCH__` differ at the 10th
    # character), so first-by-position is unambiguous.
    for token in __BRANCH_JS__ __DIR_JS__ __BRANCH__ __DIR__; do
      pre=${text%%"$token"*}
      [ "$pre" = "$text" ] && continue   # this placeholder is not in what is left
      len=${#pre}
      if [ -z "$best_len" ] || [ "$len" -lt "$best_len" ]; then
        best_len=$len
        best_token=$token
      fi
    done
    [ -z "$best_token" ] && break

    out=$out${text:0:$best_len}
    case $best_token in
      __BRANCH_JS__) out=$out$(json_esc "$(json_esc "$BRANCH")") ;;
      __DIR_JS__)    out=$out$(json_esc "$(json_esc "$DIR")") ;;
      __BRANCH__)    out=$out$(json_esc "$BRANCH") ;;
      __DIR__)       out=$out$(json_esc "$DIR") ;;
    esac
    text=${text:$((best_len + ${#best_token}))}
  done

  printf '%s\n' "$out$text" > "$2"
}

for f in "$WORK"/*.tmpl; do
  render "$f" "${f%.tmpl}.json"
done

# ── helpers ─────────────────────────────────────────────────────────────────

# Aborts the run on a refused write, so the closing "how to read this" block
# with its expected sha256 can never follow a route that stored nothing.
# `curl --fail` alone would not do: a JSON-RPC answer is HTTP 200 even when the
# call failed, so the body is checked as well.
send() { # send <body-file> <url>
  echo "--- request body on the wire ($(basename "$1")) ---"
  od -c "$1"
  local status
  status=$(curl -sS -X POST "$2" \
    -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data-binary "@$1" \
    -o "$WORK/answer.txt" -w '%{http_code}')
  cat "$WORK/answer.txt"
  echo
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "ABORT: $2 answered HTTP $status — the body above is the refusal, nothing was stored" >&2
    exit 1
  fi
  # Quotes may be backslash-escaped: a tool's own answer travels as JSON text
  # nested inside the JSON-RPC answer, where `"success":false` arrives as
  # `\"success\":false`.
  if grep -Eq '\\?"error\\?"[[:space:]]*:|\\?"isError\\?"[[:space:]]*:[[:space:]]*true|\\?"success\\?"[[:space:]]*:[[:space:]]*false' "$WORK/answer.txt"; then
    echo "ABORT: $2 answered HTTP $status but the body above reports an error" >&2
    exit 1
  fi
}

# macOS ships `shasum`, Linux images ship `sha256sum`; few ship both.
sha256_of() { # sha256_of <file>
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | awk '{print $1}'
  else
    shasum -a 256 < "$1" | awk '{print $1}'
  fi
}

# Checks the status before hashing, for the same reason `send` does: a 401 from
# an expired JWT or a 404 from a wrong path would otherwise be dumped and
# hashed as though it were the file's own content, and the run would end
# looking complete.
read_bytes() { # read_bytes <workspace path>
  echo "--- stored bytes of $1 ---"
  local status
  if [ -n "$JWT" ]; then
    # The raw file route serves the file's own bytes, nothing JSON-encoded.
    status=$(curl -sS -H "Authorization: Bearer $JWT" \
      --get "$BASE/api/workspace/$WSID/file/raw" --data-urlencode "path=$1" \
      -o "$WORK/stored.bin" -w '%{http_code}')
    if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
      echo "ABORT: the raw-file read of $1 answered HTTP $status, so what follows is that refusal, not the stored bytes:" >&2
      cat "$WORK/stored.bin" >&2
      echo >&2
      exit 1
    fi
    od -c "$WORK/stored.bin"
    echo "sha256: $(sha256_of "$WORK/stored.bin")  bytes: $(wc -c < "$WORK/stored.bin")"
  else
    echo '(no JWT — raw text of the read_file answer; `\\u0041` here means the six characters are stored)'
    status=$(curl -sS -X POST "$BASE/api/agent/tools/read_file" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d "{\"branch\":$(json_str "$BRANCH"),\"path\":$(json_str "$1")}" \
      -o "$WORK/stored.txt" -w '%{http_code}')
    if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
      echo "ABORT: the read_file call for $1 answered HTTP $status, so what follows is that refusal, not the stored bytes:" >&2
      cat "$WORK/stored.txt" >&2
      echo >&2
      exit 1
    fi
    od -c "$WORK/stored.txt"
  fi
  echo
}

# ── route 1: the tool route ─────────────────────────────────────────────────

echo "=== route 1: POST /api/agent/tools/write_file ==="
send "$WORK/1-tool-route.json" "$BASE/api/agent/tools/write_file"
read_bytes "$DIR/route-tool.md"

# ── route 2: the MCP endpoint ───────────────────────────────────────────────

echo "=== route 2: POST /api/mcp — tools/call write_file ==="
send "$WORK/2-mcp.json" "$BASE/api/mcp"
read_bytes "$DIR/route-mcp.md"

# ── route 3: call_tool_chain ────────────────────────────────────────────────

echo "=== route 3: POST /api/mcp — tools/call call_tool_chain ==="
send "$WORK/3-chain.json" "$BASE/api/mcp"
read_bytes "$DIR/route-chain.md"

cat <<'EOF'
=== how to read this ===
For each route, the stored bytes must begin with the six characters
    \   u   0   0   4   1
and must NOT begin with the single letter
    A
Expected in full, 19 bytes:  \ u 0 0 4 1 | \ " | \ \ | \ n | — (em dash, 3 bytes)
sha256: 92665b31a414950ac8112771e237a5dfd44010127d45c2a91e12dec4baf77264
EOF
