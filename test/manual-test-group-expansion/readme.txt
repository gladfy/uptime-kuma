Smoke E2E da expansao de grupo na status page (show_children).
Sobe um server dedicado e valida os endpoints publicos de ponta a ponta:

  mkdir -p data/test-smoke && echo '{"type":"sqlite"}' > data/test-smoke/db-config.json
  node server/server.js --port=3005 --data-dir=./data/test-smoke/ &
  node test/manual-test-group-expansion/smoke.js
  # depois: kill do server e rm -rf data/test-smoke
