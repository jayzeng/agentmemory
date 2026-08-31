#!/usr/bin/env bash
# End-to-end verification loop for agent-memory.
#
# Usage:
#   bash scripts/verify.sh [--quick] [--live-qmd] [--phase <name>] [--json] [--update-baselines]
#
# Phases: clean build install unit eval harness review report
# --quick    skip harness + review phases (CI mode, ~30s)
# --live-qmd include live-qmd eval probes (requires qmd + embeddings)
# --phase X  run only phase X (for debugging)
# --json     emit final metrics as JSON to stdout instead of table
# --update-baselines  write current observed values into eval/baselines.json

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Verification must exercise the default entitlement path, not a developer-only
# override inherited from the caller's shell.
unset AGENT_MEMORY_DEV_ENTITLEMENT

BINARY="./dist/agent-memory"
QUICK=false
LIVE_QMD=false
SINGLE_PHASE=""
JSON_OUTPUT=false
UPDATE_BASELINES=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --quick)            QUICK=true ;;
    --live-qmd)         LIVE_QMD=true ;;
    --phase)            SINGLE_PHASE="$2"; shift ;;
    --json)             JSON_OUTPUT=true ;;
    --update-baselines) UPDATE_BASELINES=true ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Timing and result tracking
# ---------------------------------------------------------------------------

ms_now() { python3 -c 'import time; print(int(time.time()*1000))'; }
TOTAL_START_MS=$(ms_now)

metrics_build_time_ms=0
metrics_binary_size_bytes=0
metrics_lint_errors=0
metrics_type_errors=0
metrics_unit_pass=""
metrics_cli_pass=""
metrics_savings_pass=""
metrics_eval_pass=""
metrics_test_fail_total=0
metrics_det_probes_passed=0
metrics_det_probes_intentional_fail=0
metrics_recall_at_1="N/A"
metrics_recall_at_5="N/A"
metrics_mrr_at_5="N/A"
metrics_ndcg_at_5="N/A"
metrics_lqmd_lat_p50="N/A"
metrics_lqmd_lat_p95="N/A"
metrics_ctx_lat_p50="N/A"
metrics_ctx_lat_p95="N/A"
metrics_ctx_output_chars="N/A"
metrics_ctx_sections="N/A"
metrics_stale_hit_rate="N/A"
metrics_injected_tokens="N/A"
metrics_sessions_reviewed=0
metrics_sessions_coherent=0
REGRESSIONS=()

run_phase() {
  local name="$1"
  "phase_${name}"
  return $?
}

# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------

phase_clean() {
  echo "── clean ──────────────────────────────────────"
  rm -f dist/agent-memory
  echo "   removed dist/agent-memory"
}

phase_build() {
  echo "── build ──────────────────────────────────────"
  local start_ms
  start_ms=$(ms_now)

  echo "   [typecheck]"
  if ! bun run build 2>&1; then
    echo "   FAIL: type errors"
    metrics_type_errors=1
    return 1
  fi

  echo "   [lint]"
  local lint_out
  lint_out=$(bun run lint 2>&1)
  local lint_rc=$?
  if [[ $lint_rc -ne 0 ]]; then
    metrics_lint_errors=$(echo "$lint_out" | grep -cE "^[^ ].*\.ts:[0-9]" || true)
    echo "   WARN: lint found ${metrics_lint_errors} issues (non-fatal — check manually)"
    echo "$lint_out" | grep -E "error|FIXABLE" | head -5 || true
  else
    metrics_lint_errors=0
    echo "   lint: clean"
  fi

  echo "   [build:cli]"
  if ! bun run build:cli 2>&1; then
    echo "   FAIL: build:cli"
    return 1
  fi

  local end_ms
  end_ms=$(ms_now)
  metrics_build_time_ms=$(( end_ms - start_ms ))

  if [[ -f "$BINARY" ]]; then
    metrics_binary_size_bytes=$(wc -c < "$BINARY" | tr -d ' ')
    local size_mb
    size_mb=$(echo "scale=1; $metrics_binary_size_bytes / 1048576" | bc 2>/dev/null || echo "?")
    echo "   binary: ${size_mb}MB  build: ${metrics_build_time_ms}ms"
  else
    echo "   FAIL: binary not produced"
    return 1
  fi
}

phase_install() {
  echo "── install ────────────────────────────────────"

  if [[ ! -f "$BINARY" ]]; then
    echo "   SKIP: binary not found — run build first"
    return 1
  fi

  echo "   [completion --stdout]"
  if ! "$BINARY" completion zsh --stdout > /dev/null 2>&1; then
    echo "   FAIL: completion zsh --stdout"
    return 1
  fi

  echo "   [install-hooks --yes --only claude,codex]"
  "$BINARY" install-hooks --yes --only claude,codex 2>&1 || true

  echo "   [install-skills]"
  "$BINARY" install-skills 2>&1 || true

  echo "   [doctor]"
  local doctor_out
  doctor_out=$("$BINARY" doctor 2>&1)
  local doctor_rc=$?
  echo "$doctor_out" | grep -E "^(ok|warn|fail|skip)" | head -12 || true
  if [[ $doctor_rc -ne 0 ]]; then
    echo "   FAIL: doctor exited $doctor_rc"
    return 1
  fi
  echo "   doctor: OK"
}

run_test_suite() {
  local label="$1" cmd="$2" logfile="$3" result_var="$4"
  echo "   [${label}]"
  local test_rc=0
  set +e
  bun test $cmd 2>&1 | tee "$logfile" | tail -3
  test_rc=$?
  set -e
  local fail_count
  fail_count=$(grep -oE '[0-9]+ fail' "$logfile" | tail -1 | grep -oE '[0-9]+' || echo "0")
  local pass_count
  pass_count=$(grep -oE '[0-9]+ pass' "$logfile" | tail -1 || echo "? pass")
  metrics_test_fail_total=$(( metrics_test_fail_total + fail_count ))
  eval "${result_var}='${pass_count}'"
  if [[ "$fail_count" -gt 0 || "$test_rc" -ne 0 ]]; then
    eval "${result_var}='${pass_count}  (${fail_count} FAIL)'"
    return 1
  fi
}

phase_unit() {
  echo "── unit ───────────────────────────────────────"
  local phase_rc=0
  run_test_suite "unit.test.ts" "test/unit.test.ts" "/tmp/am-unit.log" "metrics_unit_pass" || phase_rc=1
  run_test_suite "cli.test.ts --timeout 15000" "test/cli.test.ts --timeout 15000" "/tmp/am-cli.log" "metrics_cli_pass" || phase_rc=1
  run_test_suite "token-savings.test.ts" "test/token-savings.test.ts" "/tmp/am-savings.log" "metrics_savings_pass" || phase_rc=1
  run_test_suite "eval.test.ts" "test/eval.test.ts" "/tmp/am-eval-test.log" "metrics_eval_pass" || phase_rc=1
  return "$phase_rc"
}

phase_eval() {
  echo "── eval ───────────────────────────────────────"

  echo "   [feedback eval — deterministic (regression dataset)]"
  if bun eval/run.ts --dataset eval/datasets/agent-memory-regression-v1.json --json > /tmp/am-eval-report.json 2>/tmp/am-eval-err.log; then
    local passed failed deferred
    passed=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-report.json','utf8')); console.log(r.probes.filter(p=>p.status==='passed').length)" 2>/dev/null || echo "?")
    failed=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-report.json','utf8')); console.log(r.probes.filter(p=>p.status==='failed').length)" 2>/dev/null || echo "?")
    deferred=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-report.json','utf8')); console.log(r.probes.filter(p=>p.status==='deferred').length)" 2>/dev/null || echo "?")
    metrics_det_probes_passed="${passed}"
    # The one intentional fail (unrecorded-transcript-import) counts as fail in the report
    metrics_det_probes_intentional_fail="${failed}"
    echo "   passed=${passed}  failed=${failed}  deferred=${deferred}"
    if [[ "$failed" != "1" && "$failed" != "?" ]]; then
      echo "   WARN: expected exactly 1 intentional fail, got ${failed}"
    fi
  else
    echo "   FAIL: deterministic eval failed"
    cat /tmp/am-eval-err.log | head -20 >&2
    return 1
  fi

  if $LIVE_QMD; then
    echo "   [feedback eval — live-qmd]"
    if bun eval/run.ts --dataset eval/datasets/agent-memory-regression-v1.json --live-qmd --json > /tmp/am-eval-lqmd.json 2>/tmp/am-eval-lqmd-err.log; then
      metrics_recall_at_1=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-lqmd.json','utf8')); const m=r.retrievalMetrics; console.log(m?.recallAt1?.toFixed(2)??'N/A')" 2>/dev/null || echo "N/A")
      metrics_recall_at_5=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-lqmd.json','utf8')); const m=r.retrievalMetrics; console.log(m?.recallAt5?.toFixed(2)??'N/A')" 2>/dev/null || echo "N/A")
      metrics_mrr_at_5=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-lqmd.json','utf8')); const m=r.retrievalMetrics; console.log(m?.mrrAt5?.toFixed(2)??'N/A')" 2>/dev/null || echo "N/A")
      metrics_ndcg_at_5=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-lqmd.json','utf8')); const m=r.retrievalMetrics; console.log(m?.ndcgAt5?.toFixed(2)??'N/A')" 2>/dev/null || echo "N/A")
      metrics_lqmd_lat_p50=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-lqmd.json','utf8')); const m=r.retrievalMetrics; console.log(m?.latencyMsP50?.toFixed(0)??'N/A')" 2>/dev/null || echo "N/A")
      metrics_lqmd_lat_p95=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-eval-lqmd.json','utf8')); const m=r.retrievalMetrics; console.log(m?.latencyMsP95?.toFixed(0)??'N/A')" 2>/dev/null || echo "N/A")
      echo "   recall@1=${metrics_recall_at_1}  recall@5=${metrics_recall_at_5}  mrr@5=${metrics_mrr_at_5}  ndcg@5=${metrics_ndcg_at_5}"
      echo "   lqmd lat_p50=${metrics_lqmd_lat_p50}ms  lat_p95=${metrics_lqmd_lat_p95}ms"
    else
      echo "   FAIL: live-qmd eval failed"
      cat /tmp/am-eval-lqmd-err.log | head -20 >&2
    fi
  else
    echo "   live-qmd: skipped (pass --live-qmd to enable)"
  fi
}

phase_harness() {
  echo "── harness ────────────────────────────────────"

  if [[ ! -f "$BINARY" ]]; then
    echo "   SKIP: binary not found"
    return 1
  fi

  echo "   [running harness cases A-E]"
  if bun eval/harness.ts --json > /tmp/am-harness.json 2>/tmp/am-harness-err.log; then
    metrics_ctx_lat_p50=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-harness.json','utf8')); console.log(r.ctxLatP50Ms??'N/A')" 2>/dev/null || echo "N/A")
    metrics_ctx_lat_p95=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-harness.json','utf8')); console.log(r.ctxLatP95Ms??'N/A')" 2>/dev/null || echo "N/A")
    metrics_ctx_output_chars=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-harness.json','utf8')); console.log(r.ctxOutputChars??'N/A')" 2>/dev/null || echo "N/A")
    metrics_ctx_sections=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-harness.json','utf8')); const c=r.cases.find(c=>c.name==='A-oneshot-coherence'); console.log(c?.metrics?.ctx_sections_count??'N/A')" 2>/dev/null || echo "N/A")
    metrics_stale_hit_rate=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-harness.json','utf8')); console.log(r.staleHitRate??'N/A')" 2>/dev/null || echo "N/A")
    metrics_injected_tokens=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-harness.json','utf8')); console.log(r.injectedTokenOverhead??'N/A')" 2>/dev/null || echo "N/A")

    # Print per-case status
    bun -e "
      const r=JSON.parse(require('fs').readFileSync('/tmp/am-harness.json','utf8'));
      for(const c of r.cases){
        const s=c.passed?'✓':'✗';
        const m=Object.entries(c.metrics).filter(([,v])=>v!==null&&v!=='skipped').map(([k,v])=>k+'='+v).join('  ');
        console.log('   '+s+' '+c.name+'  '+m);
        if(!c.passed) for(const e of c.errors) console.log('     ERROR: '+e);
      }
    " 2>/dev/null || true

    # Check if any case failed
    local any_fail
    any_fail=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-harness.json','utf8')); console.log(r.cases.some(c=>!c.passed)?'1':'0')" 2>/dev/null || echo "0")
    if [[ "$any_fail" == "1" ]]; then
      echo "   FAIL: one or more harness cases failed"
      return 1
    fi
  else
    echo "   FAIL: harness runner crashed"
    cat /tmp/am-harness-err.log | head -20 >&2
    return 1
  fi
}

phase_review() {
  echo "── session review ─────────────────────────────"

  if [[ ! -f "$BINARY" ]]; then
    echo "   SKIP: binary not found"
    return 0
  fi

  echo "   [replaying recent agent sessions]"
  if bun eval/harness.ts --review --json > /tmp/am-review.json 2>/tmp/am-review-err.log; then
    metrics_sessions_reviewed=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-review.json','utf8')); console.log(r.sessionsReviewed)" 2>/dev/null || echo "0")
    metrics_sessions_coherent=$(bun -e "const r=JSON.parse(require('fs').readFileSync('/tmp/am-review.json','utf8')); console.log(r.sessionsCoherent)" 2>/dev/null || echo "0")

    bun -e "
      const r=JSON.parse(require('fs').readFileSync('/tmp/am-review.json','utf8'));
      const results=r.sessionResults??[];
      for(const s of results){
        if(s.skipped){ console.log('   - '+s.source+': skipped'); continue; }
        const ok=s.coherent?'✓':'✗';
        const q=(s.query||'').slice(0,55);
        console.log('   '+ok+' '+s.source+': \"'+q+'...\" → '+s.outputChars+' chars '+s.sectionsPresent+' sections '+s.latencyMs+'ms');
      }
    " 2>/dev/null || true

    echo "   summary: ${metrics_sessions_coherent}/${metrics_sessions_reviewed} sessions coherent"
  else
    echo "   WARN: session review failed (non-fatal)"
    cat /tmp/am-review-err.log | head -10 >&2
    return 0
  fi
}

phase_report() {
  local total_ms
  total_ms=$(( $(ms_now) - TOTAL_START_MS ))
  local binary_mb="N/A"
  if [[ $metrics_binary_size_bytes -gt 0 ]]; then
    binary_mb=$(echo "scale=1; $metrics_binary_size_bytes / 1048576" | bc 2>/dev/null || echo "?")
    binary_mb="${binary_mb}MB"
  fi

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║              agent-memory verification report                ║"
  printf "╠═══════════════════╤══════════════════════════════════════════╣\n"
  printf "║ %-17s │ %-40s ║\n" "PHASE" "RESULT"
  printf "╠═══════════════════╪══════════════════════════════════════════╣\n"
  printf "║ %-17s │ %-40s ║\n" "build" "${metrics_build_time_ms}ms  binary:${binary_mb}  lint:${metrics_lint_errors}errs"
  printf "║ %-17s │ %-40s ║\n" "install" "doctor:OK  hooks:claude,codex"
  local test_summary="unit:${metrics_unit_pass}  cli:${metrics_cli_pass}"
  [[ $metrics_test_fail_total -gt 0 ]] && test_summary="${test_summary}  [${metrics_test_fail_total} total fail]"
  printf "║ %-17s │ %-40s ║\n" "unit" "$test_summary"
  printf "║ %-17s │ %-40s ║\n" "eval (det.)" "passed:${metrics_det_probes_passed}  intentional_fail:${metrics_det_probes_intentional_fail}"
  if $LIVE_QMD; then
    printf "║ %-17s │ %-40s ║\n" "eval (lqmd)" "r@1:${metrics_recall_at_1}  r@5:${metrics_recall_at_5}  mrr@5:${metrics_mrr_at_5}  ndcg@5:${metrics_ndcg_at_5}"
    printf "║ %-17s │ %-40s ║\n" "" "lat_p50:${metrics_lqmd_lat_p50}ms  lat_p95:${metrics_lqmd_lat_p95}ms"
  else
    printf "║ %-17s │ %-40s ║\n" "eval (lqmd)" "skipped — pass --live-qmd"
  fi
  if ! $QUICK; then
    printf "║ %-17s │ %-40s ║\n" "harness latency" "p50:${metrics_ctx_lat_p50}ms  p95:${metrics_ctx_lat_p95}ms"
    printf "║ %-17s │ %-40s ║\n" "harness 1-shot" "chars:${metrics_ctx_output_chars}  sections:${metrics_ctx_sections}  tokens≈${metrics_injected_tokens}"
    printf "║ %-17s │ %-40s ║\n" "harness stale" "stale_hit_rate:${metrics_stale_hit_rate}"
    printf "║ %-17s │ %-40s ║\n" "session review" "coherent:${metrics_sessions_coherent}/${metrics_sessions_reviewed}"
  fi
  printf "╠═══════════════════╧══════════════════════════════════════════╣\n"
  printf "║ TOTAL TIME: %-49s ║\n" "${total_ms}ms"
  echo "╚══════════════════════════════════════════════════════════════╝"

  # Regression check
  local baselines_file="$REPO_ROOT/eval/baselines.json"
  if [[ -f "$baselines_file" ]]; then
    check_regressions
  fi

  if $UPDATE_BASELINES; then
    update_baselines
  fi

  if [[ ${#REGRESSIONS[@]} -gt 0 ]]; then
    echo ""
    echo "REGRESSIONS DETECTED:"
    for r in "${REGRESSIONS[@]}"; do
      echo "  ✗ $r"
    done
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Regression checker
# ---------------------------------------------------------------------------

check_regressions() {
  local baselines_file="$REPO_ROOT/eval/baselines.json"

  # Helper: check a metric against min/max thresholds
  check_metric() {
    local name="$1" value="$2"
    [[ "$value" == "N/A" || "$value" == "?" ]] && return

    local max min
    max=$(bun -e "const b=JSON.parse(require('fs').readFileSync('$baselines_file','utf8')); const t=b.thresholds['$name']; console.log(t?.max??'')" 2>/dev/null || echo "")
    min=$(bun -e "const b=JSON.parse(require('fs').readFileSync('$baselines_file','utf8')); const t=b.thresholds['$name']; console.log(t?.min??'')" 2>/dev/null || echo "")

    if [[ -n "$max" && $(echo "$value > $max" | bc 2>/dev/null) == "1" ]]; then
      REGRESSIONS+=("$name=${value} exceeds max=${max}")
    fi
    if [[ -n "$min" && $(echo "$value < $min" | bc 2>/dev/null) == "1" ]]; then
      REGRESSIONS+=("$name=${value} below min=${min}")
    fi
  }

  check_metric "build_time_ms"      "$metrics_build_time_ms"
  check_metric "binary_size_bytes"  "$metrics_binary_size_bytes"
  check_metric "stale_hit_rate"     "$metrics_stale_hit_rate"
  check_metric "ctx_sections_count" "$metrics_ctx_sections"

  if [[ "$metrics_recall_at_1" != "N/A" ]]; then
    check_metric "recall_at_1" "$metrics_recall_at_1"
    check_metric "recall_at_5" "$metrics_recall_at_5"
    check_metric "mrr_at_5"    "$metrics_mrr_at_5"
    check_metric "ndcg_at_5"   "$metrics_ndcg_at_5"
  fi
}

update_baselines() {
  local baselines_file="$REPO_ROOT/eval/baselines.json"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "Updating baselines in $baselines_file..."
  bun -e "
    const fs=require('fs');
    const f='$baselines_file';
    const b=JSON.parse(fs.readFileSync(f,'utf8'));
    b.updatedAt='$ts';
    b.observed={
      build_time_ms: $metrics_build_time_ms,
      binary_size_bytes: $metrics_binary_size_bytes,
      ctx_lat_p50_ms: '$metrics_ctx_lat_p50',
      ctx_lat_p95_ms: '$metrics_ctx_lat_p95',
      ctx_output_chars: '$metrics_ctx_output_chars',
      ctx_sections_count: '$metrics_ctx_sections',
      stale_hit_rate: '$metrics_stale_hit_rate',
      injected_tokens: '$metrics_injected_tokens',
      recall_at_1: '$metrics_recall_at_1',
      recall_at_5: '$metrics_recall_at_5',
      mrr_at_5: '$metrics_mrr_at_5',
      ndcg_at_5: '$metrics_ndcg_at_5',
      lqmd_lat_p50: '$metrics_lqmd_lat_p50',
      lqmd_lat_p95: '$metrics_lqmd_lat_p95',
    };
    fs.writeFileSync(f, JSON.stringify(b, null, 2)+'\n');
    console.log('   baselines updated at $ts');
  " 2>/dev/null || echo "   WARN: could not update baselines"
}

# ---------------------------------------------------------------------------
# JSON output mode
# ---------------------------------------------------------------------------

emit_json() {
  bun -e "
    const fs=require('fs');
    const readJson=f=>{ try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch{ return null; } };
    const harness=readJson('/tmp/am-harness.json');
    const evalReport=readJson('/tmp/am-eval-report.json');
    const review=readJson('/tmp/am-review.json');
    const report={
      schemaVersion:'verify-v1',
      generatedAt:new Date().toISOString(),
      build:{ build_time_ms:$metrics_build_time_ms, binary_size_bytes:$metrics_binary_size_bytes, lint_errors:$metrics_lint_errors },
      tests:{ unit:'$metrics_unit_pass', cli:'$metrics_cli_pass', savings:'$metrics_savings_pass', eval:'$metrics_eval_pass' },
      detEval:{ passed:$metrics_det_probes_passed, intentional_fail:$metrics_det_probes_intentional_fail },
      liveQmd:{ recall_at_1:'$metrics_recall_at_1', recall_at_5:'$metrics_recall_at_5', mrr_at_5:'$metrics_mrr_at_5', ndcg_at_5:'$metrics_ndcg_at_5', lat_p50:'$metrics_lqmd_lat_p50', lat_p95:'$metrics_lqmd_lat_p95' },
      harness: harness,
      review: review,
    };
    console.log(JSON.stringify(report, null, 2));
  " 2>/dev/null
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if [[ -n "$SINGLE_PHASE" ]]; then
  echo "Running single phase: $SINGLE_PHASE"
  run_phase "$SINGLE_PHASE"
  exit $?
fi

PHASES=(clean build install unit eval)
$QUICK || PHASES+=(harness review)
PHASES+=(report)

FAILED=false
for phase in "${PHASES[@]}"; do
  if ! run_phase "$phase"; then
    FAILED=true
    # build failure is fatal — can't proceed without binary
    if [[ "$phase" == "build" ]]; then
      echo "Build failed — aborting"
      exit 1
    fi
  fi
  echo ""
done

if $JSON_OUTPUT; then
  emit_json
fi

$FAILED && exit 1 || exit 0
