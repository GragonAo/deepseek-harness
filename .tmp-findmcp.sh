#!/bin/bash
echo "=== ALL containers (incl. stopped) with ports ==="
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'

echo
echo "=== who owns host port 19830? ==="
for c in $(docker ps -a --format '{{.Names}}'); do
  p=$(docker inspect "$c" --format '{{json .NetworkSettings.Ports}}' 2>/dev/null)
  echo "$p" | grep -q '19830' && echo "  -> $c : $p"
done

echo
echo "=== jeecg-boot-mcp-server image / dir? ==="
docker images --format '{{.Repository}}:{{.Tag}}' | grep -i 'jeecg\|mcp' | head -10
find / -maxdepth 5 -iname '*mcp-server*' -not -path '/proc/*' 2>/dev/null | head -10
