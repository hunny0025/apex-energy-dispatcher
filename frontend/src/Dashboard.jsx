import { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const POLL_MS  = 5000;

const fmt = (n, dec = 0) => n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: dec });
const pct = n => n == null ? "—" : `${Number(n).toFixed(1)}%`;

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function StatCard({ label, value, sub, color = "neutral" }) {
  const cls = { green: "text-emerald-400", red: "text-red-400", amber: "text-amber-400", blue: "text-blue-400", neutral: "text-slate-200" };
  return (
    <div className="bg-slate-800 rounded-xl p-4 flex flex-col gap-1 border border-slate-700/50">
      <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
      <p className={`font-bold text-2xl ${cls[color]}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function PhaseTag({ phase }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold
      ${phase === 1 ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                    : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"}`}>
      <span className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ background: phase === 1 ? "#f59e0b" : "#34d399" }} />
      {phase === 1 ? "PHASE 1 — RAMP" : "PHASE 2 — OPTIMAL"}
    </span>
  );
}

function SensorBadge({ name, faulted }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium
      ${faulted ? "bg-red-500/10 border border-red-500/30 text-red-400"
                : "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400"}`}>
      <span className={`w-2 h-2 rounded-full ${faulted ? "bg-red-400" : "bg-emerald-400"}`} />
      <span>{name}</span>
      <span className="text-xs opacity-60">{faulted ? "FAULT" : "OK"}</span>
    </div>
  );
}

function WScore({ w }) {
  const color = w >= 0.9 ? "#34d399" : w >= 0.6 ? "#f59e0b" : "#f87171";
  const label = w >= 0.9 ? "All clear" : w >= 0.6 ? "Risk buffer active" : "⚠ Human review";
  const r = 36, circ = 2 * Math.PI * r, dash = circ * w;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#1e293b" strokeWidth="8" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" transform="rotate(-90 50 50)" />
        <text x="50" y="46" textAnchor="middle" fill={color} fontSize="16" fontWeight="bold">{w.toFixed(2)}</text>
        <text x="50" y="62" textAnchor="middle" fill="#64748b" fontSize="9">w score</text>
      </svg>
      <span className="text-xs font-medium" style={{ color }}>{label}</span>
    </div>
  );
}

export default function Dashboard() {
  const [deficit, setDeficit]   = useState(90);
  const [beta, setBeta]         = useState(1.0);
  const [faultMode, setFault]   = useState(false);
  const [phase, setPhase]       = useState(2);
  const [dispatch, setDispatch] = useState(null);
  const [sensors, setSensors]   = useState(null);
  const [forecast, setForecast] = useState(null);
  const [pareto, setPareto]     = useState([]);
  const [auditLog, setAudit]    = useState([]);
  const [costHist, setCostHist] = useState([]);
  const [error, setError]       = useState(null);
  const phaseTimer = useRef(null);

  const w = sensors?.w_score ?? 1.0;

  const fetchDispatch = useCallback(async () => {
    try {
      const data = await apiFetch("/dispatch", {
        method: "POST",
        body: JSON.stringify({ deficit_mw: deficit, beta, w }),
      });
      setDispatch(data);
      setCostHist(p => [...p.slice(-29), {
        t: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        cost: data.total_cost, baseline: data.baseline_cost,
      }]);
      setError(null);
    } catch (e) { setError(`API: ${e.message}`); }
  }, [deficit, beta, w]);

  const fetchSensors = useCallback(async () => {
    try {
      const data = await apiFetch("/sensors", {
        method: "POST",
        body: JSON.stringify({ scada_load: faultMode ? 750 : 495, res_output: faultMode ? 0 : 148, grid_reading: 348 }),
      });
      setSensors(data);
    } catch (e) { /* non-critical */ }
  }, [faultMode]);

  const fetchForecast = useCallback(async () => {
    try {
      const data = await apiFetch("/forecast", {
        method: "POST",
        body: JSON.stringify({ current_load: 500, weather_severity: faultMode ? 0.9 : 0.3, res_output: faultMode ? 60 : 145 }),
      });
      setForecast(data);
    } catch (e) { /* non-critical */ }
  }, [faultMode]);

  const fetchPareto = useCallback(async () => {
    try {
      const data = await apiFetch(`/pareto?deficit_mw=${deficit}&w=${w}`);
      setPareto(Array.isArray(data) ? data : []);
    } catch (e) { /* non-critical */ }
  }, [deficit, w]);

  const fetchAudit = useCallback(async () => {
    try {
      const data = await apiFetch("/audit?limit=8");
      setAudit(data.log ?? []);
    } catch (e) { /* non-critical */ }
  }, []);

  useEffect(() => { fetchSensors(); fetchForecast(); }, []);
  useEffect(() => { fetchDispatch(); const id = setInterval(fetchDispatch, POLL_MS); return () => clearInterval(id); }, [fetchDispatch]);
  useEffect(() => { fetchSensors();  const id = setInterval(fetchSensors, 3000);     return () => clearInterval(id); }, [fetchSensors]);
  useEffect(() => { fetchPareto(); }, [fetchPareto]);
  useEffect(() => { fetchAudit();    const id = setInterval(fetchAudit, 10000);      return () => clearInterval(id); }, [fetchAudit]);

  const triggerPhase1 = () => {
    setPhase(1);
    clearTimeout(phaseTimer.current);
    phaseTimer.current = setTimeout(() => setPhase(2), 3000);
  };

  const p2 = dispatch?.phase2 ?? {};
  const humanReview = w < 0.6;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-5">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">APEX</h1>
          <p className="text-sm text-slate-400">AI Energy Dispatcher — Energy-O-Thon 2026</p>
        </div>
        <div className="flex gap-3 items-center flex-wrap justify-end">
          {humanReview && (
            <span className="px-3 py-1 bg-red-500/20 border border-red-500/30 text-red-400 text-xs font-bold rounded-full animate-pulse">
              ⚠ HUMAN REVIEW
            </span>
          )}
          <PhaseTag phase={phase} />
          <span className="px-3 py-1 bg-red-600/20 border border-red-600/30 text-red-400 text-xs font-bold rounded-full">
            DEFICIT: {deficit} MW
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-900/30 border border-red-700/50 text-red-300 text-sm rounded-lg">{error}</div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <StatCard label="Optimized cost"    value={`$${fmt(dispatch?.total_cost)}`}    sub="/hr" color="green" />
        <StatCard label="Baseline (diesel)" value={`$${fmt(dispatch?.baseline_cost)}`} sub="/hr" />
        <StatCard label="Savings"           value={pct(dispatch?.savings_pct)}         sub={`$${fmt(dispatch?.savings_dollar)}/hr`} color="green" />
        <StatCard label="CO₂ emissions"     value={`${fmt(p2?.co2_tonnes, 1)} t`}      sub="/hr" color={beta >= 2 ? "green" : "amber"} />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">

        {/* LEFT — Controls */}
        <div className="space-y-4">
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/50">
            <p className="text-xs text-slate-400 uppercase mb-2">Deficit (MW)</p>
            <input type="range" min="10" max="90" step="5" value={deficit}
              onChange={e => { setDeficit(+e.target.value); triggerPhase1(); }}
              className="w-full accent-blue-500" />
            <p className="text-2xl font-bold text-red-400 mt-1">{deficit} MW</p>
          </div>

          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/50">
            <div className="flex justify-between mb-1">
              <p className="text-xs text-slate-400 uppercase">ESG Weight (β)</p>
              <p className={`text-xs font-bold ${beta <= 1 ? "text-amber-400" : beta <= 2 ? "text-blue-400" : "text-emerald-400"}`}>
                {beta <= 1 ? "Cost priority" : beta <= 2 ? "Balanced" : "ESG priority"}
              </p>
            </div>
            <input type="range" min="0.5" max="3.0" step="0.5" value={beta}
              onChange={e => setBeta(+e.target.value)}
              className="w-full accent-blue-500" />
            <div className="flex justify-between text-xs text-slate-600 mt-1">
              <span>β=0.5 cost</span>
              <span className="text-white font-bold">β={beta}</span>
              <span>β=3.0 green</span>
            </div>
          </div>

          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/50">
            <div className="flex justify-between items-center mb-3">
              <p className="text-xs text-slate-400 uppercase">Sensor Mode</p>
              <button onClick={() => setFault(v => !v)}
                className={`px-3 py-1 rounded text-xs font-bold transition
                  ${faultMode ? "bg-red-600 text-white" : "bg-slate-700 hover:bg-slate-600 text-slate-300"}`}>
                {faultMode ? "FAULTS ACTIVE" : "ALL HEALTHY"}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {sensors?.faults
                ? Object.entries(sensors.faults).map(([n, d]) => (
                    <SensorBadge key={n} name={n.toUpperCase()} faulted={d?.flagged ?? false} />
                  ))
                : ["SCADA","RES","GRID"].map(n => <SensorBadge key={n} name={n} faulted={false} />)
              }
            </div>
          </div>

          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/50 flex justify-center">
            <WScore w={w} />
          </div>

          {forecast && (
            <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/50">
              <p className="text-xs text-slate-400 uppercase mb-3">LSTM Forecast (T+15 min)</p>
              <div className="grid grid-cols-3 gap-2">
                <div><p className="text-xs text-slate-500">P50</p>
                  <p className="text-lg font-bold text-blue-400">{fmt(forecast.p50_forecast_mw, 0)} MW</p></div>
                <div><p className="text-xs text-slate-500">P90</p>
                  <p className="text-lg font-bold text-amber-400">{fmt(forecast.p90_forecast_mw, 0)} MW</p></div>
                <div><p className="text-xs text-slate-500">Action</p>
                  <p className={`text-lg font-bold ${forecast.trigger_early_action ? "text-red-400" : "text-emerald-400"}`}>
                    {forecast.trigger_early_action ? "ACT" : "WATCH"}
                  </p></div>
              </div>
            </div>
          )}
        </div>

        {/* CENTRE — Dispatch table */}
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/50">
          <p className="text-xs text-slate-400 uppercase mb-3">MILP Dispatch Decision</p>
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700 text-xs text-slate-500">
                <th className="text-left pb-2">Load</th>
                <th className="text-right pb-2">MW</th>
                <th className="text-right pb-2">Cost/hr</th>
                <th className="text-right pb-2">Status</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {[
                { label: "HVAC",     mw: p2.HVAC_shed  ? 20 : 0, cost: p2.HVAC_shed  ? "$3,000" : "—", status: p2.HVAC_shed  ? "SHED" : "ON",  sc: p2.HVAC_shed  ? "text-amber-400" : "text-emerald-400" },
                { label: "Pump",     mw: p2.Pump_shed  ? 30 : 0, cost: p2.Pump_shed  ? "$5,000" : "—", status: p2.Pump_shed  ? "SHED" : "ON",  sc: p2.Pump_shed  ? "text-amber-400" : "text-emerald-400" },
                { label: "Diesel",   mw: fmt(p2.P_diesel, 0), cost: p2.P_diesel > 0 ? `$${fmt(p2.P_diesel * 231, 0)}` : "—", status: p2.P_diesel > 0 ? "ACTIVE" : "OFF", sc: p2.P_diesel > 0 ? "text-blue-400" : "text-slate-500" },
                { label: "Rolling",  mw: p2.Rolling_full ? 40 : fmt(p2.Rolling_partial_mw, 0) || 0, cost: p2.Rolling_full ? "$15,000" : "—", status: p2.Rolling_full ? "SHED" : "ON", sc: p2.Rolling_full ? "text-amber-400" : "text-emerald-400" },
                { label: "Critical", mw: 0, cost: "—", status: "PROTECTED", sc: "text-emerald-400" },
              ].map(r => (
                <tr key={r.label} className="border-b border-slate-700/50">
                  <td className="py-2.5 text-slate-300">{r.label}</td>
                  <td className="py-2.5 text-right font-mono text-white">{r.mw}</td>
                  <td className="py-2.5 text-right font-mono text-slate-400">{r.cost}</td>
                  <td className={`py-2.5 text-right font-bold ${r.sc}`}>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 pt-3 border-t border-slate-700 space-y-1.5">
            {[
              { label: "Optimized", val: `$${fmt(dispatch?.total_cost)}/hr`, cls: "text-emerald-400 font-bold" },
              { label: "Baseline",  val: `$${fmt(dispatch?.baseline_cost)}/hr`, cls: "text-slate-400" },
              { label: "Saved",     val: `${pct(dispatch?.savings_pct)} · $${fmt(dispatch?.savings_dollar)}/hr`, cls: "text-emerald-400 font-bold" },
            ].map(r => (
              <div key={r.label} className="flex justify-between text-sm">
                <span className="text-slate-500">{r.label}</span>
                <span className={r.cls}>{r.val}</span>
              </div>
            ))}
            {w < 1.0 && (
              <div className="flex justify-between text-xs mt-1">
                <span className="text-slate-500">Risk buffer (w={w.toFixed(2)})</span>
                <span className="text-amber-400">+${fmt(dispatch?.phase2?.risk_penalty)}/hr</span>
              </div>
            )}
          </div>

          {costHist.length > 2 && (
            <div className="mt-4">
              <p className="text-xs text-slate-500 mb-2">Cost history ($/hr)</p>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={costHist}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="t" tick={{ fontSize: 9, fill: "#64748b" }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: "#64748b" }} width={50} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                  <Line dataKey="baseline" stroke="#475569" strokeWidth={1} dot={false} />
                  <Line dataKey="cost"     stroke="#34d399" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* RIGHT — Pareto */}
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/50">
          <p className="text-xs text-slate-400 uppercase mb-1">Cost vs CO₂ Tradeoff (Pareto)</p>
          <p className="text-xs text-slate-600 mb-3">Move β slider to shift the optimal point</p>
          <ResponsiveContainer width="100%" height={180}>
            <ScatterChart>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis dataKey="co2"  tick={{ fontSize: 10, fill: "#64748b" }} name="CO₂" label={{ value: "CO₂ t/hr", fill: "#64748b", fontSize: 10, position: "insideBottom", offset: -2 }} />
              <YAxis dataKey="cost" tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
              <Tooltip contentStyle={{ background: "#0f172a", border: "none", borderRadius: 8 }}
                formatter={(v, n) => [n === "co2" ? `${v.toFixed(1)} t/hr` : `$${fmt(v)}/hr`, n === "co2" ? "CO₂" : "Cost"]} />
              <Scatter data={pareto} fill="#3b82f6"
                shape={(props) => {
                  const cur = Math.abs((props.payload?.co2 ?? 0) - (p2?.co2_tonnes ?? 0)) < 5;
                  return <circle cx={props.cx} cy={props.cy} r={cur ? 7 : 5}
                    fill={cur ? "#34d399" : "#3b82f6"} stroke={cur ? "#fff" : "none"} strokeWidth={cur ? 1.5 : 0} />;
                }} />
            </ScatterChart>
          </ResponsiveContainer>
          <table className="w-full text-xs mt-3">
            <thead>
              <tr className="border-b border-slate-700 text-slate-500">
                <th className="text-left pb-1">β</th>
                <th className="text-right pb-1">Cost/hr</th>
                <th className="text-right pb-1">CO₂</th>
                <th className="text-right pb-1">Mode</th>
              </tr>
            </thead>
            <tbody>
              {pareto.map(r => (
                <tr key={r.beta} className={`border-b border-slate-800/50 ${r.beta === beta ? "text-emerald-400 font-bold" : "text-slate-400"}`}>
                  <td className="py-1">{r.beta}</td>
                  <td className="text-right">${fmt(r.cost)}</td>
                  <td className="text-right">{fmt(r.co2, 1)}</td>
                  <td className="text-right">{r.beta <= 1 ? "cost" : r.beta <= 2 ? "bal" : "ESG"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Audit log */}
      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/50">
        <div className="flex justify-between items-center mb-3">
          <p className="text-xs text-slate-400 uppercase">ESG Audit Log</p>
          <span className="text-xs text-slate-600">Hash-chained · Append-only</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-slate-500">
                {["Time","Deficit MW","Cost $/hr","CO₂ t/hr","β","w","Saved"].map(h => (
                  <th key={h} className={`pb-2 pr-4 ${h === "Time" ? "text-left" : "text-right"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {auditLog.length === 0 && (
                <tr><td colSpan={7} className="py-4 text-center text-slate-600">No records yet</td></tr>
              )}
              {auditLog.map((rec, i) => (
                <tr key={i} className="border-b border-slate-800/50 text-slate-400 hover:text-slate-200 transition">
                  <td className="py-1.5 pr-4 text-slate-500">{rec.timestamp ? new Date(rec.timestamp).toLocaleTimeString() : "—"}</td>
                  <td className="text-right pr-4">{fmt(rec.deficit_mw)}</td>
                  <td className="text-right pr-4">${fmt(rec.total_cost_hr)}</td>
                  <td className="text-right pr-4">{fmt(rec.co2_tonnes_hr, 1)}</td>
                  <td className="text-right pr-4">{rec.beta}</td>
                  <td className={`text-right pr-4 ${rec.w_score < 0.6 ? "text-red-400" : ""}`}>{rec.w_score?.toFixed(2)}</td>
                  <td className="text-right text-emerald-400 font-medium">${fmt(rec.savings_dollar)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 text-center text-xs text-slate-700">
        APEX — AI Energy Dispatcher · Energy-O-Thon 2026 · Team 9010
      </div>
    </div>
  );
}
