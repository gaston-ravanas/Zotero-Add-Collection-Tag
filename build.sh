#!/usr/bin/env bash
# Builds the plugin into build/:
#   build/zotero-add-collection-tag-<version>.xpi
#   build/updates.json  (the update manifest Zotero checks; see update_url in manifest.json)
# The version, plugin ID and supported Zotero versions all come from manifest.json.
set -euo pipefail
cd "$(dirname "$0")"

REPO="${GITHUB_REPOSITORY:-gaston-ravanas/Zotero-Add-Collection-Tag}"
FILES=(bootstrap.js addCollectionTag.js manifest.json prefs.js preferences.xhtml)

version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
xpi="zotero-add-collection-tag-${version}.xpi"

rm -rf build
mkdir build
zip -X -q "build/${xpi}" "${FILES[@]}"

if command -v sha256sum >/dev/null; then
  hash=$(sha256sum "build/${xpi}" | cut -d' ' -f1)
else
  hash=$(shasum -a 256 "build/${xpi}" | cut -d' ' -f1)
fi

python3 - "$xpi" "$hash" "$REPO" <<'EOF'
import json, sys
xpi, sha, repo = sys.argv[1:]
manifest = json.load(open("manifest.json"))
zotero = manifest["applications"]["zotero"]
version = manifest["version"]
updates = {
    "addons": {
        zotero["id"]: {
            "updates": [
                {
                    "version": version,
                    "update_link": f"https://github.com/{repo}/releases/download/v{version}/{xpi}",
                    "update_hash": f"sha256:{sha}",
                    "applications": {
                        "zotero": {
                            "strict_min_version": zotero["strict_min_version"],
                            "strict_max_version": zotero["strict_max_version"],
                        }
                    },
                }
            ]
        }
    }
}
with open("build/updates.json", "w") as f:
    json.dump(updates, f, indent=2)
    f.write("\n")
EOF

echo "Built build/${xpi} and build/updates.json (version ${version})"
