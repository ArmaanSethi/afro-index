#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
ACTIVE_PID=""

cleanup() {
  local code=$?
  if [[ -n "${ACTIVE_PID}" ]] && kill -0 "${ACTIVE_PID}" 2>/dev/null; then
    kill -TERM -"${ACTIVE_PID}" 2>/dev/null || kill -TERM "${ACTIVE_PID}" 2>/dev/null || true
    wait "${ACTIVE_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMP_DIR}"
  exit "${code}"
}
trap cleanup EXIT INT TERM

usage() {
  cat >&2 <<'EOF'
Usage: bash tests/e2e/run_e2e.sh [--tier 1|2|3|4]

Options:
  --tier N, --tier=N, -t N   Run only the specified E2E tier (1, 2, 3, or 4)
  -h, --help                 Show this help message
EOF
}

SELECTED_TIERS=(1 2 3 4)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier|-t)
      if [[ $# -lt 2 ]]; then
        echo "Error: $1 requires a tier number (1-4)" >&2
        usage
        exit 2
      fi
      TIER_VAL="$2"
      shift 2
      if [[ ! "${TIER_VAL}" =~ ^[1-4]$ ]]; then
        echo "Error: invalid tier '${TIER_VAL}' (expected 1, 2, 3, or 4)" >&2
        usage
        exit 2
      fi
      SELECTED_TIERS=("${TIER_VAL}")
      ;;
    --tier=*)
      TIER_VAL="${1#--tier=}"
      shift
      if [[ ! "${TIER_VAL}" =~ ^[1-4]$ ]]; then
        echo "Error: invalid tier '${TIER_VAL}' (expected 1, 2, 3, or 4)" >&2
        usage
        exit 2
      fi
      SELECTED_TIERS=("${TIER_VAL}")
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'" >&2
      usage
      exit 2
      ;;
  esac
done

declare -a ROW_TIER=()
declare -a ROW_LAYER=()
declare -a ROW_STATUS=()
declare -a ROW_PASS=()
declare -a ROW_FAIL=()
declare -a ROW_SKIP=()
declare -a ROW_DUR=()

TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_SKIPPED=0
OVERALL_FAILED_LAYERS=0
SUITE_START_MS="$(date +%s%3N)"

format_duration() {
  local ms="$1"
  python3 -c "print(f'{int(${ms})/1000:.1f}s')"
}

parse_tap_counts() {
  local logfile="$1"
  python3 - "$logfile" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
def last_int(pattern):
    matches = re.findall(pattern, text, re.M)
    return int(matches[-1]) if matches else 0
total = last_int(r"^# tests (\d+)")
passed = last_int(r"^# pass (\d+)")
failed = last_int(r"^# fail (\d+)")
skipped = last_int(r"^# skipped (\d+)")
print(f"{total} {passed} {failed} {skipped}")
PY
}

parse_unittest_counts() {
  local logfile="$1"
  python3 - "$logfile" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m_ran = re.search(r"Ran (\d+) tests?", text)
total = int(m_ran.group(1)) if m_ran else 0
m_fail = re.search(r"failures=(\d+)", text)
m_err = re.search(r"errors=(\d+)", text)
m_skip = re.search(r"skipped=(\d+)", text)
failed = (int(m_fail.group(1)) if m_fail else 0) + (int(m_err.group(1)) if m_err else 0)
skipped = int(m_skip.group(1)) if m_skip else 0
passed = max(0, total - failed - skipped)
print(f"{total} {passed} {failed} {skipped}")
PY
}

record_row() {
  local tier="$1" layer="$2" status="$3" passed="$4" failed="$5" skipped="$6" dur_ms="$7"
  ROW_TIER+=("T${tier}")
  ROW_LAYER+=("${layer}")
  ROW_STATUS+=("${status}")
  ROW_PASS+=("${passed}")
  ROW_FAIL+=("${failed}")
  ROW_SKIP+=("${skipped}")
  ROW_DUR+=("$(format_duration "${dur_ms}")")

  TOTAL_PASSED=$((TOTAL_PASSED + passed))
  TOTAL_FAILED=$((TOTAL_FAILED + failed))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + skipped))
  if [[ "${status}" != "PASS" ]]; then
    OVERALL_FAILED_LAYERS=$((OVERALL_FAILED_LAYERS + 1))
  fi
}

cd "${REPO_ROOT}"

for T in "${SELECTED_TIERS[@]}"; do
  # --- 1. Node API Layer ---
  echo "======================================================================"
  echo "[Tier ${T} | API] Running Node API/DB/Config E2E tests..."
  echo "======================================================================"
  shopt -s nullglob
  api_files=(tests/e2e/api/tier${T}_*.test.mjs)
  shopt -u nullglob

  t_start="$(date +%s%3N)"
  if [[ ${#api_files[@]} -eq 0 ]]; then
    echo "ERROR: No API test files found for Tier ${T} (tests/e2e/api/tier${T}_*.test.mjs)" >&2
    record_row "${T}" "API" "FAIL" 0 1 0 0
  else
    api_log="${TMP_DIR}/t${T}_api.log"
    node --test --test-reporter=tap "${api_files[@]}" 2>&1 | tee "${api_log}"
    api_rc="${PIPESTATUS[0]}"
    t_end="$(date +%s%3N)"
    dur_ms=$((t_end - t_start))

    read -r total passed failed skipped <<< "$(parse_tap_counts "${api_log}")"
    if [[ "${api_rc}" -ne 0 || "${total}" -eq 0 ]]; then
      status="FAIL"
      if [[ "${failed}" -eq 0 ]]; then
        failed=1
      fi
    else
      status="PASS"
    fi
    record_row "${T}" "API" "${status}" "${passed}" "${failed}" "${skipped}" "${dur_ms}"
  fi

  # --- 2. Python Playwright Browser Layer ---
  echo "======================================================================"
  echo "[Tier ${T} | Browser] Running Python Playwright/Chrome E2E tests..."
  echo "======================================================================"
  shopt -s nullglob
  browser_files=(tests/e2e/browser/test_tier${T}_*.py)
  shopt -u nullglob

  t_start="$(date +%s%3N)"
  if [[ ${#browser_files[@]} -eq 0 ]]; then
    echo "ERROR: No Browser test files found for Tier ${T} (tests/e2e/browser/test_tier${T}_*.py)" >&2
    record_row "${T}" "Browser" "FAIL" 0 1 0 0
  else
    browser_log="${TMP_DIR}/t${T}_browser.log"
    python3 -m unittest discover -s tests/e2e/browser -p "test_tier${T}_*.py" -v 2>&1 | tee "${browser_log}"
    browser_rc="${PIPESTATUS[0]}"
    t_end="$(date +%s%3N)"
    dur_ms=$((t_end - t_start))

    read -r total passed failed skipped <<< "$(parse_unittest_counts "${browser_log}")"
    if [[ "${browser_rc}" -ne 0 || "${total}" -eq 0 ]]; then
      status="FAIL"
      if [[ "${failed}" -eq 0 ]]; then
        failed=1
      fi
    else
      status="PASS"
    fi
    record_row "${T}" "Browser" "${status}" "${passed}" "${failed}" "${skipped}" "${dur_ms}"
  fi
done

SUITE_END_MS="$(date +%s%3N)"
TOTAL_DUR="$(format_duration "$((SUITE_END_MS - SUITE_START_MS))")"

if [[ "${OVERALL_FAILED_LAYERS}" -eq 0 && "${TOTAL_FAILED}" -eq 0 && "${TOTAL_PASSED}" -gt 0 ]]; then
  OVERALL_STATUS="PASS"
  FINAL_RC=0
else
  OVERALL_STATUS="FAIL"
  FINAL_RC=1
fi

echo ""
echo "======================================================================"
echo "afro-index E2E Test Summary"
echo "======================================================================"
printf "%-4s | %-7s | %-6s | %6s | %6s | %7s | %8s\n" "Tier" "Layer" "Status" "Passed" "Failed" "Skipped" "Duration"
echo "-----+---------+--------+--------+--------+---------+---------"
for i in "${!ROW_TIER[@]}"; do
  printf "%-4s | %-7s | %-6s | %6s | %6s | %7s | %8s\n" \
    "${ROW_TIER[$i]}" "${ROW_LAYER[$i]}" "${ROW_STATUS[$i]}" \
    "${ROW_PASS[$i]}" "${ROW_FAIL[$i]}" "${ROW_SKIP[$i]}" "${ROW_DUR[$i]}"
done
echo "-----+---------+--------+--------+--------+---------+---------"
printf "%-4s | %-7s | %-6s | %6s | %6s | %7s | %8s\n" \
  "ALL" "TOTAL" "${OVERALL_STATUS}" "${TOTAL_PASSED}" "${TOTAL_FAILED}" "${TOTAL_SKIPPED}" "${TOTAL_DUR}"
echo "======================================================================"

exit "${FINAL_RC}"
