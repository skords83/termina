#!/usr/bin/env bash
set -euo pipefail

# Read the actual Compose project from the existing Termina container. Preserve
# its project name so a path change never creates a different database volume.
container=termina-backend
if ! docker inspect --type container "$container" >/dev/null 2>&1; then
  container=termina-frontend
fi
label() {
  docker inspect --type container --format "{{ index .Config.Labels \"$1\" }}" "$container"
}
project=$(label com.docker.compose.project)
working_dir=$(label com.docker.compose.project.working_dir)
config_files=$(label com.docker.compose.project.config_files)
if [[ -z "$project" || "$project" == '<no value>' || -z "$config_files" || "$config_files" == '<no value>' ]]; then
  echo 'Cannot identify the existing Termina Compose project. No containers were changed.' >&2
  exit 1
fi

# Dockhand may record paths inside its own container. Translate these using
# Docker's real mount sources instead of guessing a volume or stack directory.
mapfile -t containers < <(docker ps -aq)
mounts=$(docker inspect --type container --format '{{range .Mounts}}{{printf "%s\t%s\n" .Source .Destination}}{{end}}' "${containers[@]}")
resolve_path() {
  local requested=$1 source destination candidate found=''
  if [[ -e "$requested" ]]; then
    printf '%s\n' "$requested"
    return
  fi
  while IFS=$'\t' read -r source destination; do
    [[ -n "$source" && -n "$destination" ]] || continue
    if [[ "$requested" == "$destination" || "$requested" == "$destination/"* ]]; then
      candidate="$source${requested#"$destination"}"
      if [[ -e "$candidate" ]]; then
        if [[ -n "$found" && "$found" != "$candidate" ]]; then
          echo 'Ambiguous Dockhand path. Set the TERMINA_DEPLOY_DIR repository variable.' >&2
          return 1
        fi
        found=$candidate
      fi
    fi
  done <<< "$mounts"
  [[ -n "$found" ]] || { echo "Deployment path not found: $requested. Set TERMINA_DEPLOY_DIR to the current host stack directory." >&2; return 1; }
  printf '%s\n' "$found"
}

if [[ -n "${TERMINA_DEPLOY_DIR:-}" ]]; then
  directory=$TERMINA_DEPLOY_DIR
else
  directory=$(resolve_path "$working_dir")
fi
[[ -d "$directory" ]] || { echo 'Deployment directory does not exist; stopping.' >&2; exit 1; }
compose=(docker compose --project-name "$project" --project-directory "$directory")
IFS=',' read -ra files <<< "$config_files"
for file in "${files[@]}"; do
  if [[ -n "${TERMINA_DEPLOY_DIR:-}" ]]; then
    file="$directory/$(basename "$file")"
  elif [[ "$file" != /* ]]; then
    file="$directory/$file"
  else
    file=$(resolve_path "$file")
  fi
  [[ -f "$file" ]] || { echo "Compose file does not exist: $file" >&2; exit 1; }
  compose+=(-f "$file")
done

cd "$directory"
"${compose[@]}" config --quiet
"${compose[@]}" pull
"${compose[@]}" up -d --wait --wait-timeout 120
