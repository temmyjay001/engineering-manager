#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

npx -y @mermaid-js/mermaid-cli -i pipeline.mmd -o assets/pipeline-light.svg -c mermaid-light.json -b transparent
npx -y @mermaid-js/mermaid-cli -i pipeline.mmd -o assets/pipeline-dark.svg -c mermaid-dark.json -b transparent

perl -pi -e 's/#552222/#000000/g; s/#333333/#000000/g; s/#707070/#e5e5e5/g' assets/pipeline-light.svg
perl -pi -e 's/#552222/#ffffff/g; s/#333333/#ffffff/g; s/#707070/#1a1a1a/g' assets/pipeline-dark.svg

for f in assets/pipeline-light.svg assets/pipeline-dark.svg; do
  w=$(grep -o 'viewBox="0 0 [0-9.]* [0-9.]*"' "$f" | head -1 | awk '{print $3}')
  perl -0777 -pi -e "s/(<svg [^>]*?)width=\"100%\"/\${1}width=\"${w}\"/" "$f"
done
