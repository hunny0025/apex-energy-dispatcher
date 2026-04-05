import { useState, useEffect, useRef, useCallback } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from "recharts";

const C = {
  bg: "#040810", bg1: "#070d18", bg2: "#0a1220", bg3: "#0e1829",
  border: "#112240", border2: "#1a3355",
  green: "#00ff88", greenD: "#00ff8820",
  teal: "#00d4ff", tealD: "#00d4ff18",
  amber: "#ffb800", amberD: "#ffb80018",
  red: "#ff3366", redD: "#ff336620",
  purple: "#8b5cf6", purpleD: "#8b5cf618",
  blue: "#3b82f6", blueD: "#3b82f618",
  text: "#cdd9e5", textDim: "#5d7a9a", textBright: "#e8f4ff"
};

const HISTORY = 60;
let tickCount = 0;

function generateTick(scenario, beta) {
  tickCount++;
  const t = tickCount, h = (t * 0.05) % 24;
  const sc = {
    normal: { rf: 1, lf: 1, wNoise: .88 },
    res_drop: { rf: .38, lf: 1, wNoise: .7 }, 
    demand_spike: { rf: 1, lf: 1.25, wNoise: .85 },
    storm: { rf: .3, lf: 1.1, wNoise: .62 },
    night_low: { rf: .05, lf: .75, wNoise: .95 }
  }[scenario] || { rf: 1, lf: 1, wNoise: .88 };

  const baseLoad = 448 + 38 * Math.sin(2 * Math.PI * (h - 8) / 24) + (Math.random() - .5) * 14;
  const load = Math.max(300, baseLoad * sc.lf);
  const solarPeak = Math.max(0, Math.sin(Math.PI * (h - 6) / 12));
  const solar = 98 * solarPeak * (.65 + Math.random() * .35) * sc.rf;
  const wind = Math.max(0, 52 + (Math.random() - .5) * 28) * sc.rf;
  const renewable = solar + wind;
  const gridCap = 350;
  const gridSupply = Math.min(gridCap, Math.max(0, load - renewable));
  const deficit = Math.max(0, load - renewable - gridSupply);

  const w = Math.max(.4, sc.wNoise + (Math.random() - .5) * .06);
  const p50 = deficit * (1 + (Math.random() - .5) * .08);
  const p90 = p50 * (1.14 + (1 - w) * .22);
  const spread = p90 - p50;
  
  const eff = p90;
  let rem = eff;

  const hvacMax = 20, pumpMax = 30, rollingMax = 40;
  let hvac = 0, pump = 0, rolling = 0, diesel = 0;

  if (rem > 0) { hvac = Math.min(rem, hvacMax); rem -= hvac; }
  if (rem > 0) { pump = Math.min(rem, pumpMax); rem -= pump; }
  if (rem > 0) { rolling = Math.min(rem, rollingMax); rem -= rolling; }
  if (rem > 0) { diesel = rem; rem -= diesel; }

  const hCost = hvac * (3000 / 20);
  const pCost = pump * (5000 / 30);
  const rCost = rolling * (15000 / 40);
  const dFuel = diesel * 150;
  const risk = (1 - w) * 0.1 * eff * 150;

  const opCost = dFuel + hCost + pCost + rCost + risk;
  const co2 = diesel * 0.9;
  const esgPenalty = co2 * 90;
  const totalLoss = opCost + (beta * esgPenalty);

  const base = eff * 150;
  const freq = 50 + (Math.random() - .5) * .8 - deficit * .01;
  const riskLvl = deficit > 60 ? "HIGH" : deficit > 20 ? "MED" : "LOW";
  
  let explainer = "All systems functioning normally.";
  if (deficit > 0) {
    if (diesel > 0) explainer = `High deficit requires DIESEL (${diesel.toFixed(1)} MW). Limits reached.`;
    else if (rolling > 0) explainer = `ROLLING MILL shutdown triggered after HVAC & PUMP tier.`;
    else explainer = `Deficit handled via HVAC/PUMP tier shedding.`;
  }

  return {
    t, ts: new Date().toLocaleTimeString("en", { hour12: false }),
    load: +load.toFixed(1), solar: +solar.toFixed(1), wind: +wind.toFixed(1),
    renewable: +renewable.toFixed(1), gridSupply: +gridSupply.toFixed(1),
    deficit: +deficit.toFixed(1), p50: +p50.toFixed(1), p90: +p90.toFixed(1), spread: +spread.toFixed(1),
    w: +w.toFixed(3), diesel: +diesel.toFixed(1), hvac: +hvac.toFixed(1), pump: +pump.toFixed(1), rolling: +rolling.toFixed(1),
    hvacMax, pumpMax, rollingMax,
    dFuel: +dFuel.toFixed(0), hCost: +hCost.toFixed(0), pCost: +pCost.toFixed(0), rCost: +rCost.toFixed(0),
    sheddingCost: +(hCost + pCost + rCost).toFixed(0), risk: +risk.toFixed(0),
    opCost: +opCost.toFixed(0), co2: +co2.toFixed(1), esgPenalty: +esgPenalty.toFixed(0),
    totalLoss: +totalLoss.toFixed(0), base: +base.toFixed(0),
    explainer,
    savings: +(((base - opCost) / Math.max(base, 1)) * 100).toFixed(1),
    freq: +freq.toFixed(3), riskLvl, phase: scenario === 'res_drop' || scenario === 'storm' ? 2 : 1,
    latencyLstm: +(12 + Math.random() * 8).toFixed(1), latencyMilp: +(8 + Math.random() * 12).toFixed(1)
  };
}

const Blink = ({ active, color }) => (
  <span style={{
    display: "inline-block", width: 7, height: 7, borderRadius: "50%",
    background: active ? color : C.textDim, boxShadow: active ? `0 0 8px ${color}` : "none",
    animation: active ? "pulse 1.4s ease-in-out infinite" : "none"
  }} />
);

const Badge = ({ label, color, dim }) => (
  <span style={{
    fontSize: 9, fontFamily: "monospace", letterSpacing: 1, padding: "2px 6px",
    borderRadius: 3, border: `1px solid ${color}44`, background: dim || `${color}15`,
    color, fontWeight: 700
  }}>{label}</span>
);

const Metric = ({ label, value, unit, color, size = 22, sub }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
    <span style={{ fontSize: 9, color: C.textDim, fontFamily: "monospace", letterSpacing: 1 }}>{label}</span>
    <span style={{ fontSize: size, fontWeight: 700, color: color || C.textBright, fontFamily: "monospace", lineHeight: 1 }}>
      {value}<span style={{ fontSize: size * .45, color: C.textDim, marginLeft: 2 }}>{unit}</span>
    </span>
    {sub && <span style={{ fontSize: 9, color: C.textDim }}>{sub}</span>}
  </div>
);

const Panel = ({ title, badge, children, style, accent }) => (
  <div style={{
    background: C.bg2, border: `1px solid ${C.border}`, borderTop: `2px solid ${accent || C.border2}`,
    borderRadius: 4, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, overflow: "hidden", ...style
  }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontSize: 9, color: C.textDim, fontFamily: "monospace", letterSpacing: 2, fontWeight: 700 }}>{title}</span>
      {badge}
    </div>
    {children}
  </div>
);

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#050c18ee", border: `1px solid ${C.border2}`, borderRadius: 4, padding: "8px 12px", fontFamily: "monospace", fontSize: 11, zIndex: 100 }}>
      <div style={{ color: C.textDim, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || C.text, display: "flex", gap: 8, justifyContent: "space-between" }}>
          <span>{p.name}</span><span style={{ fontWeight: 700 }}>{typeof p.value === "number" ? p.value.toFixed(1) : p.value}</span>
        </div>
      ))}
    </div>
  );
};

export default function App() {
  const [history, setHistory] = useState([]);
  const [current, setCurrent] = useState(null);
  const [scenario, setScenario] = useState("normal");
  const [beta, setBeta] = useState(1.0);
  const [speed, setSpeed] = useState(1);
  const [activeTab, setActiveTab] = useState("command");
  const [paused, setPaused] = useState(false);
  const intervalRef = useRef(null);

  const tick = useCallback(() => {
    if (paused) return;
    const next = generateTick(scenario, beta);
    setCurrent(next);
    setHistory(h => {
      const n = [...h, next];
      return n.length > HISTORY ? n.slice(-HISTORY) : n;
    });
  }, [paused, scenario, beta]);

  useEffect(() => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(tick, 2000 / speed);
    return () => clearInterval(intervalRef.current);
  }, [tick, speed]);

  const cur = current;
  if (!cur) return <div style={{ background: C.bg, height: "100vh" }} />;

  const riskColor = cur.riskLvl === "HIGH" ? C.red : cur.riskLvl === "MED" ? C.amber : C.green;
  const NAV = [
    { id: "command", label: "CMD CTR" },
    { id: "risk", label: "RISK" },
    { id: "sim", label: "SIM" },
    { id: "audit", label: "AUDIT" }
  ];

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "'IBM Plex Mono','Courier New',monospace", height: "100vh", display: "flex", flexDirection: "column", fontSize: 12, userSelect: "none", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0 }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-track { background: ${C.bg1} }
        ::-webkit-scrollbar-thumb { background: ${C.border2}; border-radius: 2px }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }
      `}</style>
      
      {/* Header */}
      <div style={{ background: C.bg1, borderBottom: `1px solid ${C.border}`, padding: "0 16px", height: 50, display: "flex", alignItems: "center", gap: 20, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, border: `2px solid ${C.teal}`, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: C.tealD }}>
            <span style={{ fontSize: 16, color: C.teal, fontWeight: 700 }}>⚡</span>
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.teal, letterSpacing: 4, lineHeight: 1 }}>APEX</div>
            <div style={{ fontSize: 9, color: C.textDim, letterSpacing: 2, marginTop: 2 }}>AI ENERGY DISPATCHER v2.1</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, marginLeft: 12 }}>
          {NAV.map(n => (
            <button key={n.id} onClick={() => setActiveTab(n.id)} style={{
              background: activeTab === n.id ? C.tealD : "transparent",
              border: `1px solid ${activeTab === n.id ? C.teal + "66" : C.border}`,
              color: activeTab === n.id ? C.teal : C.textDim,
              borderRadius: 4, padding: "4px 12px", fontSize: 10, fontFamily: "monospace", letterSpacing: 1, cursor: "pointer", fontWeight: activeTab === n.id ? 700 : 400, transition: "all 0.2s"
            }}>
              {n.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Blink active color={riskColor} />
            <Badge label={cur.riskLvl} color={riskColor} />
          </div>
          <div style={{ fontSize: 9, color: C.textDim }}>{cur.ts}</div>
          <button onClick={() => setPaused(p => !p)} style={{
            background: paused ? C.amberD : "transparent", border: `1px solid ${paused ? C.amber : C.border}`,
            color: paused ? C.amber : C.textDim, borderRadius: 4, padding: "2px 8px", fontSize: 9, fontFamily: "monospace", letterSpacing: 1, cursor: "pointer"
          }}>
            {paused ? "▶ RESUME" : "⏸ PAUSE"}
          </button>
        </div>
      </div>

      {/* Main Area */}
      <div style={{ flex: 1, padding: "8px", display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" }}>
        
        {activeTab === "command" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, flexShrink: 0 }}>
              <Panel title="TOTAL LOAD" accent={C.blue}><Metric label="LOAD" value={cur.load} unit="MW" color={C.blue} size={22} /></Panel>
              <Panel title="RENEWABLE" accent={C.green}><Metric label="SOLAR+WIND" value={cur.renewable} unit="MW" color={C.green} size={22} /></Panel>
              <Panel title="GRID SUPPLY" accent={C.amber}><Metric label="GRID IMPORT" value={cur.gridSupply} unit="MW" color={C.amber} size={22} /></Panel>
              <Panel title="CURRENT DEFICIT" accent={cur.deficit > 0 ? C.red : C.teal} style={{ background: cur.deficit > 0 ? C.redD : C.bg2 }}><Metric label="DEFICIT" value={cur.deficit} unit="MW" color={cur.deficit > 0 ? C.red : C.teal} size={22} /></Panel>
              <Panel title="TOTAL LOSS" accent={C.purple}><Metric label="TOTAL $/HR" value={cur.totalLoss.toLocaleString()} unit="" color={C.purple} size={22} /></Panel>
              <Panel title="CO₂ EMISSIONS" accent={C.teal}><Metric label="TONS/HR" value={cur.co2} unit="t" color={C.teal} size={22} /></Panel>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 8, flex: 1, overflow: "hidden" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Panel title="POWER FLOW OVERVIEW" accent={C.teal} style={{ flex: 1 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={history} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                      <defs>
                        <linearGradient id="gload" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.blue} stopOpacity={.25} /><stop offset="95%" stopColor={C.blue} stopOpacity={.02} /></linearGradient>
                        <linearGradient id="grenewable" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.green} stopOpacity={.25} /><stop offset="95%" stopColor={C.green} stopOpacity={.02} /></linearGradient>
                      </defs>
                      <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                      <XAxis dataKey="ts" tick={{ fill: C.textDim, fontSize: 8 }} interval={9} />
                      <YAxis tick={{ fill: C.textDim, fontSize: 8 }} />
                      <Tooltip content={<TT />} />
                      <Area type="monotone" dataKey="load" name="Load" stroke={C.blue} fill="url(#gload)" strokeWidth={2} dot={false} />
                      <Area type="monotone" dataKey="renewable" name="Renewable" stroke={C.green} fill="url(#grenewable)" strokeWidth={2} dot={false} />
                      <Area type="monotone" dataKey="deficit" name="Deficit" stroke={C.red} fill="none" strokeWidth={2} strokeDasharray="4 2" />
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, height: 160 }}>
                  <Panel title="COST BREAKDOWN" accent={C.purple}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={[{ name: "Diesel", v: cur.dFuel, c: C.blue }, { name: "Shedding", v: cur.sheddingCost, c: C.amber }, { name: "ESG", v: cur.esgPenalty, c: C.teal }]}>
                        <CartesianGrid stroke={C.border} strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="name" tick={{ fill: C.textDim, fontSize: 8 }} />
                        <YAxis tick={{ fill: C.textDim, fontSize: 8 }} />
                        <Tooltip content={<TT />} />
                        <Bar dataKey="v" name="$/hr" radius={[2, 2, 0, 0]}>{[C.blue, C.amber, C.teal].map((c, i) => <Cell key={i} fill={c} fillOpacity={.8} />)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="PARETO SCATTER" accent={C.green}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                        <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                        <XAxis dataKey="co2" name="CO₂" type="number" tick={{ fill: C.textDim, fontSize: 8 }} />
                        <YAxis dataKey="opCost" name="Cost" type="number" tick={{ fill: C.textDim, fontSize: 8 }} />
                        <Tooltip cursor={{ stroke: C.border2 }} content={<TT />} />
                        <Scatter data={history} fill={C.green} fillOpacity={.6} />
                      </ScatterChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Panel title="DECISION CONTROLS" accent={C.teal}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 9, color: C.textDim }}>SCENARIO:</div>
                    {[["normal", "NORMAL"], ["res_drop", "RES DROP"], ["demand_spike", "SPIKE"]].map(([k, v]) => (
                      <button key={k} onClick={() => setScenario(k)} style={{
                        background: scenario === k ? C.tealD : "transparent", border: `1px solid ${scenario === k ? C.teal : C.border}`,
                        color: scenario === k ? C.teal : C.textDim, borderRadius: 3, padding: "4px 8px", fontSize: 9, fontFamily: "monospace", cursor: "pointer", transition: "0.2s"
                      }}>{v}</button>
                    ))}
                    <div style={{ marginTop: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.textDim, marginBottom: 4 }}>
                        <span>ESG β:</span><span>{beta.toFixed(2)}</span>
                      </div>
                      <input type="range" min={0.5} max={3.0} step={0.1} value={beta} onChange={e => setBeta(+e.target.value)} style={{ width: "100%", accentColor: C.purple, cursor: "pointer" }} />
                    </div>
                  </div>
                </Panel>
                <Panel title="SHEDDING STATUS" accent={C.red} badge={<Badge label={`${(cur.hvac+cur.pump+cur.rolling).toFixed(1)} MW`} color={C.red}/>}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[["HVAC", cur.hvac, 20], ["PUMP", cur.pump, 30], ["ROLLING", cur.rolling, 40], ["DIESEL", cur.diesel, 90]].map(([l, v, m]) => (
                      <div key={l}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, marginBottom: 2 }}>
                          <span style={{ color: C.textDim }}>{l}</span>
                          <span style={{ color: v > 0 ? C.red : C.textDim, fontWeight: 700 }}>{v.toFixed(1)} / {m} MW</span>
                        </div>
                        <div style={{ height: 4, background: C.border, borderRadius: 2 }}><div style={{ height: "100%", background: v > 0 ? (l === "DIESEL" ? C.blue : C.red) : C.border, width: `${(v / m) * 100}%`, borderRadius: 2 }} /></div>
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel title="EXPLAINER" accent={C.green} style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.6, height: "100%", display: "flex", alignItems: "center" }}>{cur.explainer}</div>
                </Panel>
              </div>
            </div>
          </>
        )}

        {activeTab === "risk" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 8, flex: 1 }}>
            <Panel title="P90 RISK BOUNDS" accent={C.red}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                  <XAxis dataKey="ts" tick={{ fill: C.textDim, fontSize: 8 }} interval={9} />
                  <YAxis tick={{ fill: C.textDim, fontSize: 8 }} />
                  <Tooltip content={<TT />} />
                  <Line type="monotone" dataKey="p90" name="P90 Risk" stroke={C.amber} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="p50" name="P50 Mean" stroke={C.teal} strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
                  <Line type="monotone" dataKey="deficit" name="Actual Deficit" stroke={C.red} strokeWidth={1} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
            <Panel title="SENSOR CONFIDENCE (w)" accent={C.teal}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                  <XAxis dataKey="ts" tick={{ fill: C.textDim, fontSize: 8 }} interval={9} />
                  <YAxis domain={[0, 1]} tick={{ fill: C.textDim, fontSize: 8 }} />
                  <Tooltip content={<TT />} />
                  <Area type="monotone" dataKey="w" name="ConfidenceScore" stroke={C.teal} fill={C.tealD} strokeWidth={2} dot={false} />
                  <ReferenceLine y={0.6} stroke={C.red} strokeDasharray="3 3" />
                </AreaChart>
              </ResponsiveContainer>
            </Panel>
            <Panel title="RISK DENSITY SCAN" accent={C.purple}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                  <XAxis dataKey="deficit" name="Deficit" type="number" tick={{ fill: C.textDim, fontSize: 8 }} />
                  <YAxis dataKey="spread" name="Spread" type="number" tick={{ fill: C.textDim, fontSize: 8 }} />
                  <Tooltip content={<TT />} />
                  <Scatter data={history} fill={C.purple} fillOpacity={0.5} />
                </ScatterChart>
              </ResponsiveContainer>
            </Panel>
            <Panel title="GRID FREQUENCY STABILITY" accent={C.blue}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                  <XAxis dataKey="ts" tick={{ fill: C.textDim, fontSize: 8 }} interval={9} />
                  <YAxis domain={[49, 51]} tick={{ fill: C.textDim, fontSize: 8 }} />
                  <Tooltip content={<TT />} />
                  <Line type="monotone" dataKey="freq" name="Freq (Hz)" stroke={C.blue} strokeWidth={2} dot={false} />
                  <ReferenceLine y={50} stroke={C.green} strokeDasharray="3 3" />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        )}

        {activeTab === "sim" && (
          <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 8, flex: 1 }}>
            <Panel title="SIMULATION OVERRIDES" accent={C.amber}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ background: C.bg3, padding: 8, borderRadius: 4 }}>
                  <div style={{ fontSize: 9, color: C.textDim, marginBottom: 4 }}>SIMULATION SPEED</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[1, 5, 20].map(s => (
                      <button key={s} onClick={() => setSpeed(s)} style={{
                        flex: 1, background: speed === s ? C.amberD : "transparent", border: `1px solid ${speed === s ? C.amber : C.border}`,
                        color: speed === s ? C.amber : C.textDim, padding: "4px", fontSize: 10, borderRadius: 3, cursor: "pointer"
                      }}>{s}X</button>
                    ))}
                  </div>
                </div>
                <div style={{ background: C.bg3, padding: 8, borderRadius: 4, flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 9, color: C.textDim }}>LOSS FUNCTION VARIABLES</div>
                  <Metric label="BETA WEIGHT" value={beta.toFixed(2)} color={C.purple} size={20} />
                  <Metric label="FUEL PRICE" value="150" unit="$/MWh" size={16} />
                  <Metric label="CO2 TAX" value="90" unit="$/ton" size={16} />
                  <div style={{ flex: 1 }} />
                  <div style={{ fontSize: 8, color: C.textDim, fontStyle: "italic" }}>
                    Loss = OpCost(p,h) + β × Penalty(p)<br/>
                    Minimizing across multi-tier constraints.
                  </div>
                </div>
              </div>
            </Panel>
            <Panel title="PARETO FRONTIER: COST VS ESG" accent={C.green}>
              <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                <div style={{ flex: 1 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 10 }}>
                      <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                      <XAxis type="number" dataKey="co2" name="CO₂ Emissions (tons/hr)" label={{ value: 'CO₂ t/hr', position: 'bottom', fill: C.textDim, fontSize: 10 }} tick={{ fill: C.textDim, fontSize: 9 }} />
                      <YAxis type="number" dataKey="opCost" name="Total Cost ($/hr)" label={{ value: 'Cost $/hr', angle: -90, position: 'left', fill: C.textDim, fontSize: 10 }} tick={{ fill: C.textDim, fontSize: 9 }} />
                      <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<TT />} />
                      <Scatter data={history} fill={C.green} fillOpacity={0.6}>
                        {history.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.totalLoss > entry.base ? C.red : C.green} />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ height: 40, borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: C.textDim }}>
                   β-ADAPTIVE OPTIMAL SURFACE MAP · REAL-TIME MILP UPDATES
                </div>
              </div>
            </Panel>
          </div>
        )}

        {activeTab === "audit" && (
          <Panel title="DECISION AUDIT CHAIN" accent={C.green} style={{ flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                <Panel title="LSTM LATENCY" style={{ padding: 6, background: C.bg3 }}><Metric value={cur.latencyLstm} unit="ms" size={16} /></Panel>
                <Panel title="MILP SOLVE TIME" style={{ padding: 6, background: C.bg3 }}><Metric value={cur.latencyMilp} unit="ms" size={16} /></Panel>
                <Panel title="AUDIT RECORDS" style={{ padding: 6, background: C.bg3 }}><Metric value={history.length} unit="pts" size={16} /></Panel>
              </div>
              <div style={{ flex: 1, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 4 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: "monospace" }}>
                  <thead style={{ position: "sticky", top: 0, background: C.bg2, color: C.textDim, borderBottom: `1px solid ${C.border}` }}>
                    <tr>
                      <th style={{ padding: "4px 8px", textAlign: "left" }}>T-STAMP</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>DEFICIT</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>DIESEL</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>SHED</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>β</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>SAVINGS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...history].reverse().map((h, i) => (
                      <tr key={h.t} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "transparent" : C.bg1 }}>
                        <td style={{ padding: "3px 8px" }}>{h.ts}</td>
                        <td style={{ padding: "3px 8px", textAlign: "right", color: h.deficit > 0 ? C.red : C.teal }}>{h.deficit}</td>
                        <td style={{ padding: "3px 8px", textAlign: "right", color: C.blue }}>{h.diesel}</td>
                        <td style={{ padding: "3px 8px", textAlign: "right", color: C.amber }}>{(h.hvac+h.pump+h.rolling).toFixed(1)}</td>
                        <td style={{ padding: "3px 8px", textAlign: "right" }}>{beta.toFixed(2)}</td>
                        <td style={{ padding: "3px 8px", textAlign: "right", color: C.green }}>{h.savings}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Panel>
        )}

      </div>

      {/* Footer */}
      <div style={{ background: C.bg1, borderTop: `1px solid ${C.border}`, padding: "4px 16px", display: "flex", alignItems: "center", gap: 16, height: 24, flexShrink: 0 }}>
        <span style={{ fontSize: 8, color: C.textDim, letterSpacing: 1 }}>APEX INDUSTRIAL DECISION SYSTEM</span>
        <span style={{ fontSize: 8, color: C.border2 }}>|</span>
        <span style={{ fontSize: 8, color: C.textDim }}>MODE: <span style={{ color: C.teal }}>{scenario.toUpperCase()}</span></span>
        <span style={{ fontSize: 8, color: C.border2 }}>|</span>
        <span style={{ fontSize: 8, color: C.textDim }}>β: <span style={{ color: C.purple }}>{beta.toFixed(1)}</span></span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 8, color: C.textDim }}>MILP + LSTM INTEGRATION · STABLE · ENERGY-O-THON 2026</span>
      </div>
    </div>
  );
}
