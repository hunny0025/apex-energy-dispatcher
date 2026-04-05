import React, { useState, useEffect, useCallback } from 'react';
import { 
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';

const COLORS = {
  bg: '#07090f', panel: '#0d1117', card: '#111827', border: '#1e2d3d',
  green: '#00d97e', yellow: '#f5a623', red: '#ff4d4d', blue: '#3b82f6',
  teal: '#06b6d4', text: '#e2e8f0', muted: '#64748b'
};

const Header = ({ time }) => (
  <div className="flex justify-between items-center px-6 py-3 border-b z-10 relative" style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border }}>
    <div className="flex items-center gap-3">
      <span className="font-mono font-bold text-xl tracking-wide text-white">APEX</span>
      <span className="text-[10px] uppercase tracking-[0.2em] px-2 py-0.5 rounded border" style={{ backgroundColor: COLORS.panel, color: COLORS.muted, borderColor: COLORS.border }}>
        AI Energy Dispatcher
      </span>
    </div>
    <div className="font-mono text-sm tracking-wider" style={{ color: COLORS.text }}>
      {time.toLocaleTimeString('en-US', { hour12: false })}
    </div>
    <div className="flex items-center space-x-4">
      <div className="flex items-center">
        <div className="w-2 h-2 rounded-full animate-pulse mr-2 bg-[#00d97e]"></div>
        <span className="text-xs font-bold tracking-wider text-[#00d97e]">LIVE SYS</span>
      </div>
      <div className="text-xs px-2 py-1 rounded font-mono border" style={{ backgroundColor: COLORS.panel, color: COLORS.teal, borderColor: COLORS.border }}>
        ~60 ms
      </div>
    </div>
  </div>
);

const AlertBanner = ({ show, message }) => {
  if (!show) return null;
  return (
    <div className="w-full bg-[#ff4d4d]/10 border-b border-[#ff4d4d] text-[#ff4d4d] px-6 py-2 text-xs font-bold uppercase tracking-wider flex justify-between items-center animate-pulse z-20 relative">
      <span>⚠ ALERT TRIGGERED</span>
      <span>{message}</span>
    </div>
  );
};

const MetricCard = ({ title, value, color, unit, subtext, highlight = false }) => (
  <div style={{ backgroundColor: highlight ? COLORS.card : COLORS.panel, borderColor: highlight ? COLORS.red : COLORS.border }} 
       className={`p-4 flex flex-col justify-between border ${highlight ? 'border-t-2' : ''} rounded-sm`}>
    <div className="text-[10px] font-bold mb-3 uppercase tracking-wider" style={{ color: COLORS.muted }}>{title}</div>
    <div className="flex justify-between items-end h-full">
      <div className="flex flex-col">
        {subtext && <span className="text-[10px] uppercase font-bold mb-1 tracking-wider" style={{ color: COLORS.text }}>{subtext}</span>}
        <span className="font-mono font-semibold" style={{ color, fontSize: '1.5rem' }}>
          {typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : value}
          {unit && <span className="text-xs ml-1 font-sans font-normal" style={{ color: COLORS.muted }}>{unit}</span>}
        </span>
      </div>
    </div>
  </div>
);

const CustomTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    return (
       <div className="p-3 border rounded shadow-xl text-xs font-mono z-50 relative" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
         <div className="mb-2 font-bold" style={{ color: COLORS.text }}>{payload[0].payload.timeStr || ''}</div>
         {payload.map((entry, idx) => (
            <div key={idx} style={{ color: entry.color || entry.fill }} className="my-0.5">
              {entry.name}: {entry.value?.toFixed ? entry.value.toFixed(1) : entry.value}
            </div>
         ))}
       </div>
    );
  }
  return null;
};

// --- VIEWS ---

const OverviewTab = ({ history, current }) => (
  <div className="flex flex-col h-full overflow-y-auto no-scrollbar p-6 space-y-6">
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <MetricCard title="PLANT STATE" value={current.plant?.load} color={COLORS.blue} unit="MW" subtext="CURRENT LOAD" />
      <MetricCard title="RENEWABLE GEN" value={current.plant?.renewable} color={COLORS.green} unit="MW" subtext="SOLAR + WIND" />
      <MetricCard title="GRID IMPORT" value={current.plant?.grid} color={COLORS.yellow} unit="MW" subtext="LIMIT: 350 MW" />
      <MetricCard title="DEFICIT RISK" value={current.risk?.gap} color={current.risk?.gap > 0 ? COLORS.red : COLORS.teal} highlight={current.risk?.gap > 0} unit="MW" subtext={current.risk?.level} />
    </div>

    <div className="flex-1 border flex flex-col rounded-sm min-h-[300px]" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}>
       <div className="p-4 border-b flex justify-between items-center" style={{ borderColor: COLORS.border }}>
         <span className="text-xs font-bold uppercase tracking-wider" style={{ color: COLORS.text }}>Power Flow Overview</span>
         <div className="flex gap-4 text-xs font-mono">
           <span style={{ color: COLORS.blue }}>● Load</span>
           <span style={{ color: COLORS.green }}>● Renewables</span>
           <span style={{ color: COLORS.yellow }}>● Grid Import</span>
           <span style={{ color: COLORS.red }}>■ Deficit</span>
         </div>
       </div>
       <div className="flex-1 p-4">
         <ResponsiveContainer width="100%" height="100%">
           <AreaChart data={history} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
             <CartesianGrid strokeDasharray="2 2" stroke={COLORS.border} vertical={false} />
             <XAxis dataKey="timeStr" stroke={COLORS.muted} tick={{fontSize: 10, fontFamily: 'Space Mono'}} minTickGap={30} />
             <YAxis stroke={COLORS.muted} tick={{fontSize: 10, fontFamily: 'Space Mono'}} />
             <Tooltip content={<CustomTooltip />} />
             <Area type="monotone" dataKey="flatRenewable" stroke={COLORS.green} fill={COLORS.green} fillOpacity={0.1} isAnimationActive={false} name="Renewables" />
             <Line type="monotone" dataKey="flatLoad" stroke={COLORS.blue} strokeWidth={2} dot={false} isAnimationActive={false} name="Load" />
             <Line type="monotone" dataKey="flatGrid" stroke={COLORS.yellow} strokeWidth={2} dot={false} isAnimationActive={false} name="Grid" />
             <Line type="stepAfter" dataKey="flatDeficit" stroke={COLORS.red} strokeWidth={2} strokeDasharray="3 3" dot={false} isAnimationActive={false} name="Deficit" />
           </AreaChart>
         </ResponsiveContainer>
       </div>
    </div>
  </div>
);

const ForecastTab = ({ history, current, scenario, setScenario, beta, setBeta }) => (
  <div className="flex flex-col h-full overflow-y-auto no-scrollbar p-6 space-y-6">
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <MetricCard title="P50 EXPECTATION" value={current.forecast?.p50} color={COLORS.teal} unit="MW" subtext="NOMINAL EXPECTED" />
      <MetricCard title="P90 RISK BAND" value={current.forecast?.p90} color={COLORS.yellow} unit="MW" highlight subtext={`WORST CASE (+${current.risk?.gap?.toFixed(1)} MW)`} />
      <MetricCard title="SENSOR CONFIDENCE" value={(current.forecast?.confidence || 0) * 100} color={current.forecast?.confidence > 0.8 ? COLORS.green : COLORS.red} unit="%" subtext="W-SCORE" />
    </div>

    <div className="flex gap-6 min-h-[300px]">
       <div className="w-2/3 border rounded-sm flex flex-col" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}>
         <div className="p-4 border-b text-xs font-bold uppercase tracking-wider" style={{ borderColor: COLORS.border, color: COLORS.text }}>Probability Forecast Bands</div>
         <div className="flex-1 p-4">
            <ResponsiveContainer width="100%" height="100%">
               <AreaChart data={history} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                 <CartesianGrid strokeDasharray="2 2" stroke={COLORS.border} vertical={false} />
                 <XAxis dataKey="timeStr" stroke={COLORS.muted} tick={{fontSize: 10, fontFamily: 'Space Mono'}} minTickGap={30} />
                 <YAxis stroke={COLORS.muted} tick={{fontSize: 10, fontFamily: 'Space Mono'}} />
                 <Tooltip content={<CustomTooltip />} />
                 <Area type="monotone" dataKey="flatP90" stroke={COLORS.yellow} strokeWidth={1} strokeDasharray="3 3" fill={COLORS.yellow} fillOpacity={0.15} name="P90 Risk" isAnimationActive={false} />
                 <Line type="monotone" dataKey="flatP50" stroke={COLORS.teal} strokeWidth={2} dot={false} name="P50 Expected" isAnimationActive={false} />
               </AreaChart>
            </ResponsiveContainer>
         </div>
       </div>
       
       <div className="w-1/3 flex flex-col gap-4">
          <div className="border rounded-sm flex flex-col p-4 w-full flex-1" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
             <div className="flex items-center justify-between mb-4">
               <div className="text-xs font-bold uppercase tracking-wider" style={{ color: COLORS.text }}>System Control / Variables</div>
             </div>
             <p className="text-[10px] leading-relaxed mb-4" style={{ color: COLORS.muted }}>Select scenario datasets to observe how the AI bounds grid instability risks.</p>
             <div className="flex flex-col gap-2">
                {['normal', 'renewable_drop', 'demand_spike'].map(s => (
                   <button key={s} onClick={() => setScenario(s)}
                           className="flex items-center justify-between px-4 py-3 border transition-colors font-mono text-[10px] uppercase w-full text-left"
                           style={{
                              borderColor: scenario === s ? COLORS.teal : COLORS.border,
                              backgroundColor: scenario === s ? COLORS.panel : 'transparent',
                              color: scenario === s ? COLORS.text : COLORS.muted,
                              borderLeftWidth: scenario === s ? '4px' : '1px'
                           }}>
                     <span>{s.replace('_', ' ')}</span>
                     {scenario === s && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS.teal }}></span>}
                   </button>
                ))}
             </div>
             
             <div className="mt-8 pt-4 border-t" style={{ borderColor: COLORS.border }}>
               <div className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: COLORS.text }}>ESG Risk Weight (β)</div>
               <div className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                     <div className="flex justify-between text-[9px] uppercase font-mono mb-1" style={{ color: COLORS.muted }}>
                        <span>Pri Cost</span>
                        <span style={{ color: COLORS.green }}>Pri Green</span>
                     </div>
                     <input type="range" min="0.5" max="3.0" step="0.1" value={beta} onChange={e => setBeta(parseFloat(e.target.value))}
                            className="w-full h-1 bg-[#1e2d3d] rounded-lg appearance-none cursor-pointer accent-[#06b6d4]" />
                  </div>
                  <div className="font-mono font-bold text-lg text-right w-8" style={{ color: COLORS.teal }}>{beta.toFixed(1)}</div>
               </div>
             </div>
          </div>
       </div>
    </div>
  </div>
);

const OptimizeTab = ({ current, costData, beta, paretoData }) => (
  <div className="flex flex-col h-full overflow-y-auto no-scrollbar p-6 space-y-6">
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <MetricCard title="DIESEL DISPATCH" value={current.decision?.diesel} color={current.decision?.diesel > 0 ? COLORS.yellow : COLORS.green} unit="MW" subtext="GENERATOR ARRAY" />
      <MetricCard title="SHEDDING ACTIVE" value={current.decision?.shed} color={current.decision?.shed > 0 ? COLORS.red : COLORS.text} unit="MW" subtext="FORCED OUTAGES" />
      <MetricCard title="OPEX PENALTY" value={`$${(current.flatDieselCost + current.flatShedCost)?.toFixed(0)}`} color={COLORS.red} unit="/hr" subtext="ACTIVE EXECUTIONS" />
      <MetricCard title="MITIGATION STATUS" value={current.decision?.action} color={current.decision?.action === 'NOMINAL' ? COLORS.green : COLORS.yellow} highlight={current.decision?.action !== 'NOMINAL'} subtext="SYS INTEGRITY" />
    </div>

    <div className="flex gap-6 min-h-[360px]">
       <div className="w-1/2 border rounded-sm flex flex-col p-5" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}>
          <div className="flex justify-between items-center mb-0">
             <div className="text-xs font-bold uppercase tracking-wider" style={{ color: COLORS.text }}>Cost vs CO2 Tradeoff (Pareto)</div>
             <div className="font-mono text-[10px] px-2 py-1 rounded border" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border, color: COLORS.teal }}>Active β = {beta.toFixed(1)}</div>
          </div>
          <div className="flex-1 w-full relative">
             <ResponsiveContainer width="100%" height="100%">
               <ScatterChart margin={{ top: 20, right: 10, bottom: 0, left: -20 }}>
                 <CartesianGrid strokeDasharray="2 2" stroke={COLORS.border} />
                 <XAxis dataKey="co2" type="number" stroke={COLORS.muted} tick={{fontSize: 10, fontFamily: 'Space Mono'}} name="CO2" unit=" t" />
                 <YAxis dataKey="cost" type="number" stroke={COLORS.muted} tick={{fontSize: 10, fontFamily: 'Space Mono'}} name="Cost" unit=" $" />
                 <Tooltip cursor={{strokeDasharray: '3 3'}} contentStyle={{backgroundColor: COLORS.card, borderColor: COLORS.border, fontSize: '11px', fontFamily: '"Space Mono", monospace'}} />
                 <Scatter name="Pareto Front" data={paretoData}>
                    {paretoData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.beta === beta ? COLORS.green : COLORS.blue} />
                    ))}
                 </Scatter>
               </ScatterChart>
             </ResponsiveContainer>
          </div>
       </div>

       <div className="w-1/2 flex flex-col gap-6">
          <div className="border flex flex-col rounded-sm p-0 flex-1" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}>
             <div className="p-4 border-b text-[10px] font-bold uppercase tracking-wider flex justify-between" style={{ borderColor: COLORS.border, color: COLORS.text }}>
                <span>MILP Dispatch Instruction</span>
                <span style={{ color: COLORS.green }}>OPTIMAL</span>
             </div>
             <table className="w-full text-xs font-mono text-left m-0 border-collapse">
               <thead className="uppercase" style={{ backgroundColor: COLORS.card, color: COLORS.muted }}>
                 <tr className="border-b" style={{ borderColor: COLORS.border }}>
                   <th className="py-2 px-4 font-normal">Asset</th>
                   <th className="py-2 px-4 font-normal text-right">Instruction</th>
                   <th className="py-2 px-4 font-normal text-right">Status</th>
                 </tr>
               </thead>
               <tbody className="divide-y divide-slate-800" style={{ color: COLORS.text }}>
                 <tr>
                   <td className="py-3 px-4">Gen Array A-D</td>
                   <td className="py-3 px-4 text-right text-yellow-400">{current.decision?.diesel?.toFixed(1) || 0} MW</td>
                   <td className="py-3 px-4 text-right">
                     <span className={`px-2 py-0.5 rounded text-[10px] ${current.decision?.diesel > 0 ? 'bg-yellow-900/30 text-yellow-400' : 'bg-slate-800 text-slate-500'}`}>
                       {current.decision?.diesel > 0 ? 'DISPATCH' : 'IDLE'}
                     </span>
                   </td>
                 </tr>
                 <tr>
                   <td className="py-3 px-4">Load Res. B</td>
                   <td className="py-3 px-4 text-right">{-current.decision?.shed?.toFixed(1) || 0} MW</td>
                   <td className="py-3 px-4 text-right">
                     <span className={`px-2 py-0.5 rounded text-[10px] ${current.decision?.shed > 0 ? 'bg-red-900/40 text-red-400' : 'bg-emerald-900/30 text-emerald-400'}`}>
                       {current.decision?.shed > 0 ? 'SHED' : 'ONLINE'}
                     </span>
                   </td>
                 </tr>
               </tbody>
             </table>
          </div>

          <div className="border rounded-sm flex flex-col p-4 h-[120px]" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
             <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: COLORS.text }}>Decision Impact Distribution ($/hr)</div>
             <ResponsiveContainer width="100%" height="100%">
                <BarChart data={costData} layout="vertical" margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                   <XAxis type="number" hide />
                   <YAxis type="category" dataKey="name" stroke={COLORS.muted} tick={{fontSize: 10, fontFamily: 'Space Grotesk'}} width={80} axisLine={false} tickLine={false} />
                   <Tooltip cursor={{fill: COLORS.border, opacity: 0.4}} contentStyle={{backgroundColor: '#000', borderColor: COLORS.border, fontSize:'10px'}} />
                   <Bar dataKey="value" isAnimationActive={false} barSize={10} radius={[0,4,4,0]}>
                      {costData.map((e, idx) => <Cell key={idx} fill={e.fill} />)}
                   </Bar>
                </BarChart>
             </ResponsiveContainer>
          </div>
       </div>
    </div>
  </div>
);

const AuditTab = ({ history, current }) => (
  <div className="flex flex-col h-full overflow-y-auto no-scrollbar p-6 space-y-6">
    <div className="flex gap-6 h-[200px]">
      <div className="w-1/3 border rounded-sm flex flex-col p-4" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}>
         <div className="text-[10px] font-bold uppercase tracking-wider mb-4 flex justify-between" style={{ color: COLORS.text }}>
            <span>Sensor Fabric Health</span>
            <span style={{ color: COLORS.green }}>NOMINAL</span>
         </div>
         <div className="space-y-4">
           {['SCADA LOAD', 'GRID METERS', 'SOLAR INV'].map(s => (
              <div key={s} className="flex flex-col gap-1.5">
                 <div className="flex justify-between font-mono text-[10px]" style={{ color: COLORS.muted }}>
                    <span>{s}</span> <span>OK</span>
                 </div>
                 <div className="w-full h-1 bg-slate-800 rounded mx-0">
                    <div className="h-full rounded" style={{ backgroundColor: COLORS.green, width: `${95 + Math.random()*5}%` }}></div>
                 </div>
              </div>
           ))}
         </div>
      </div>

      <div className="w-2/3 border rounded-sm flex flex-col p-4" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
         <div className="text-[10px] font-bold uppercase tracking-wider mb-3 flex justify-between" style={{ color: COLORS.text }}>
           <span>Active Decision Reasoning</span>
           <span className="font-mono text-[10px] bg-slate-800 px-2 rounded flex items-center" style={{ color: COLORS.teal }}>PHASE 2 - OPTIMAL</span>
         </div>
         <div className="font-mono text-xs leading-7 border-l-2 pl-4 flex-1 overflow-y-auto" style={{ borderColor: COLORS.teal, color: COLORS.text }}>
             {current.forecast?.p90 > 0 ? (
               <>
                  <div className="text-[#f5a623]">{'>'} High P90 deficit risk detected ({current.forecast.p90.toFixed(1)} MW)</div>
                  {current.decision?.shed > 0 && <div className="text-[#ff4d4d]">{'>'} ESG Cost threshold breached → {current.decision.shed.toFixed(1)} MW load shedding activated</div>}
                  {current.decision?.diesel > 0 && <div>{'>'} Diesel arrays dispatched to cover remaining {current.decision.diesel.toFixed(1)} MW reserve</div>}
                  <div className="text-[#64748b]">{'>'} Action executed to prevent unmitigated grid outage</div>
               </>
             ) : (
               <>
                  <div className="text-[#00d97e]">{'>'} Grid and Renewables fully supply requested load</div>
                  <div className="text-[#64748b]">{'>'} No reserves dispatched. P90 gap perfectly covered.</div>
               </>
             )}
         </div>
      </div>
    </div>

    <div className="flex-1 border rounded-sm flex flex-col overflow-hidden" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}>
       <div className="p-4 border-b text-[10px] font-bold uppercase tracking-wider" style={{ borderColor: COLORS.border, color: COLORS.text }}>Historical Audit Ledger</div>
       <div className="overflow-y-auto flex-1 p-0 m-0">
         <table className="w-full text-[10px] font-mono text-left m-0">
           <thead className="sticky top-0 shadow" style={{ backgroundColor: COLORS.card, color: COLORS.muted }}>
             <tr>
               <th className="py-2 px-6 font-normal uppercase">Timestamp</th>
               <th className="py-2 px-6 font-normal uppercase text-right">P90 Deficit</th>
               <th className="py-2 px-6 font-normal uppercase text-right">Action State</th>
               <th className="py-2 px-6 font-normal uppercase text-right">Shed MW</th>
               <th className="py-2 px-6 font-normal uppercase text-right">Diesel MW</th>
             </tr>
           </thead>
           <tbody className="divide-y divide-slate-800/50" style={{ color: COLORS.muted }}>
             {[...history].reverse().map((h, i) => (
               <tr key={i} className={`hover:bg-slate-800/30 ${i===0 ? 'text-white' : ''}`}>
                 <td className="py-3 px-6">{h.timeStr}</td>
                 <td className="py-3 px-6 text-right font-bold text-yellow-400">{(h.flatP90||0).toFixed(1)}</td>
                 <td className="py-3 px-6 text-right">{(h.decision?.action||'NOMINAL')}</td>
                 <td className="py-3 px-6 text-right text-red-400">{(h.decision?.shed||0).toFixed(1)}</td>
                 <td className="py-3 px-6 text-right text-teal-400">{(h.decision?.diesel||0).toFixed(1)}</td>
               </tr>
             ))}
           </tbody>
         </table>
       </div>
    </div>
  </div>
);

// --- MAIN APP COMPONENT ---

export default function App() {
  const [activeTab, setActiveTab] = useState('Overview');
  const [history, setHistory] = useState([]);
  const [scenario, setScenario] = useState('normal');
  const [beta, setBeta] = useState(1.5);
  const [currentTime, setCurrentTime] = useState(new Date());

  const generatePoint = useCallback((time, currScenario, currBeta) => {
    // Exact schema matching user request: plant, forecast, decision, risk
    const simTime = time.getTime() / 1000;
    const hour = (simTime / 120) % 24; 
    
    let load = 450 + 100 * Math.sin((hour - 8) * Math.PI / 12);
    if (currScenario === 'demand_spike') load *= 1.35;

    let solar = Math.max(0, 180 * Math.sin((hour - 6) * Math.PI / 12));
    let wind = 60 + 30 * Math.sin(hour * Math.PI / 6);
    let renewable = solar + wind;
    let confidence = 0.98;
    
    if (currScenario === 'renewable_drop') {
      renewable *= 0.3;
      confidence = 0.85;
    }

    const grid = Math.min(load - renewable, 350);
    const deficitRaw = load - renewable - 350;
    const p50 = Math.max(0, deficitRaw);
    const p90 = p50 === 0 ? 0 : p50 * (1.10 + (1 - confidence)) + 5;

    let toCover = p90;
    const dieselUnitCost = 150 + currBeta * 0.9 * 90;
    let shedMW = 0, dieselMW = 0;
    
    if (toCover > 0) {
      if (dieselUnitCost > 200) { shedMW = Math.min(toCover, 50); toCover -= shedMW; }
      dieselMW = toCover;
    }
    
    let action = 'NOMINAL';
    let riskLvl = 'NORMAL';
    if (p90 > 50) { action = 'MITIGATION'; riskLvl = 'CRITICAL'; }
    else if (p90 > 0) { action = 'ACTIVE RSV'; riskLvl = 'WARNING'; }

    return {
      timestamp: time,
      timeStr: time.toLocaleTimeString('en-US', { hour12: false }),
      plant: { load, renewable, grid },
      forecast: { p50, p90, confidence },
      decision: { diesel: dieselMW, shed: shedMW, action },
      risk: { level: riskLvl, gap: p90 - p50 },
      flatLoad: load, flatRenewable: renewable, flatGrid: grid, flatDeficit: p50,
      flatP50: p50, flatP90: p90,
      flatDieselCost: dieselMW * 150, flatShedCost: shedMW > 0 ? 3000 : 0
    };
  }, []);

  useEffect(() => {
    let t = new Date();
    t.setMinutes(t.getMinutes() - 5);
    const initHist = [];
    for (let i = 0; i < 40; i++) {
       t = new Date(t.getTime() + 2000);
       initHist.push(generatePoint(t, 'normal', 1.5));
    }
    setCurrentTime(t);
    setHistory(initHist);
  }, [generatePoint]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(prev => {
        const nextTime = new Date(prev.getTime() + 2000);
        setHistory(h => {
          const newHist = [...h, generatePoint(nextTime, scenario, beta)];
          if (newHist.length > 40) newHist.shift();
          return newHist;
        });
        return nextTime;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [scenario, beta, generatePoint]);

  const current = history.length > 0 ? history[history.length - 1] : {
     plant: {load: 0, renewable: 0, grid: 0},
     forecast: {p50: 0, p90: 0, confidence: 1},
     decision: {diesel: 0, shed: 0, action: '...'},
     risk: {level: 'NONE', gap: 0}
  };

  const showAlert = current.forecast.p90 > 20 || current.decision.shed > 0;
  const alertMsg = current.decision.shed > 0 ? `Load Shedding Active (${current.decision.shed.toFixed(1)} MW)` : `High P90 Risk Threshold (${current.forecast.p90.toFixed(1)} MW)`;

  // Derived Data for Optimization
  const costData = [
    { name: 'Diesel Fuel', value: current.flatDieselCost || 0, fill: COLORS.blue },
    { name: 'HVAC Shed', value: current.flatShedCost || 0, fill: COLORS.red }
  ];

  const paretoData = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0].map(b => {
     let toCover = current.forecast.p90 || 0;
     const dCost = 150 + b * 0.9 * 90;
     let s = false;
     if (toCover > 0 && dCost > 200) { s = true; toCover = Math.max(0, toCover - 50); }
     const cost = toCover * 150 + (s?3000:0) + ((current.forecast.p90 || 0) * 80);
     const co2 = toCover * 0.9 + 2; 
     return { beta: b, cost, co2: parseFloat(co2.toFixed(1)) };
  });

  const tabs = ['Overview', 'Forecasting', 'Optimization', 'Audit Log'];

  return (
    <div className="h-screen w-screen flex flex-col font-sans overflow-hidden" style={{ backgroundColor: COLORS.bg, color: COLORS.text }}>
      <Header time={currentTime} />
      <AlertBanner show={showAlert} message={alertMsg} />
      
      <div className="flex flex-1 overflow-hidden relative">
         {/* Sidebar */}
         <div className="w-56 flex flex-col border-r z-10" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}>
            <div className="flex-1 py-4 flex flex-col gap-1">
               {tabs.map(t => (
                  <button key={t} onClick={() => setActiveTab(t)}
                          style={{
                             backgroundColor: activeTab === t ? COLORS.card : 'transparent',
                             color: activeTab === t ? COLORS.text : COLORS.muted,
                             borderRight: activeTab === t ? `3px solid ${COLORS.teal}` : '3px solid transparent'
                          }}
                          className="px-6 py-4 font-semibold text-[11px] tracking-wider uppercase text-left transition m-0 focus:outline-none">
                     {t}
                  </button>
               ))}
            </div>
            <div className="p-4 border-t text-[9px] text-center font-mono opacity-50 uppercase" style={{ borderColor: COLORS.border }}>
               Industrial Interface
            </div>
         </div>

         {/* Content Viewport */}
         <div className="flex-1 overflow-hidden h-full">
            {activeTab === 'Overview' && <OverviewTab history={history} current={current} />}
            {activeTab === 'Forecasting' && <ForecastTab history={history} current={current} scenario={scenario} setScenario={setScenario} beta={beta} setBeta={setBeta} />}
            {activeTab === 'Optimization' && <OptimizeTab current={current} costData={costData} beta={beta} paretoData={paretoData} />}
            {activeTab === 'Audit Log' && <AuditTab history={history} current={current} />}
         </div>
      </div>
    </div>
  );
}
