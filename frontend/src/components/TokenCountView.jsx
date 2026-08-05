import React, { useState, useEffect } from 'react';
import { RefreshCw, BarChart2 } from 'lucide-react';
import TokenChart from './TokenChart';

export default function TokenCountView({ token }) {
  const [tokenData, setTokenData] = useState(null);
  const [tokenTimeframe, setTokenTimeframe] = useState('24h');
  const [loadingTokens, setLoadingTokens] = useState(false);

  const fetchTokenData = async (frame) => {
    setLoadingTokens(true);
    try {
      const res = await fetch(`/api/token-usage?timeframe=${frame}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setTokenData(data);
      }
    } catch (err) {
      console.error('Failed to fetch token usage:', err);
    } finally {
      setLoadingTokens(false);
    }
  };

  useEffect(() => {
    fetchTokenData(tokenTimeframe);
  }, [tokenTimeframe]);

  const getBucketedGraphData = () => {
    if (!tokenData || !tokenData.graphData || tokenData.graphData.length === 0) return [];

    if (tokenTimeframe === 'last_request') {
      return tokenData.graphData.map(d => ({
        label: new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        value: d.token_count
      }));
    }

    const end = new Date().getTime();
    let start = end - 24 * 60 * 60 * 1000;
    let labelFormat = { hour: '2-digit', minute: '2-digit' };
    let useDate = false;

    if (tokenTimeframe === '1h') {
      start = end - 60 * 60 * 1000;
    } else if (tokenTimeframe === '12h') {
      start = end - 12 * 60 * 60 * 1000;
    } else if (tokenTimeframe === '24h') {
      start = end - 24 * 60 * 60 * 1000;
    } else if (tokenTimeframe === '7d') {
      start = end - 7 * 24 * 60 * 60 * 1000;
      labelFormat = { month: 'short', day: 'numeric' };
      useDate = true;
    } else if (tokenTimeframe === '30d') {
      start = end - 30 * 24 * 60 * 60 * 1000;
      labelFormat = { month: 'short', day: 'numeric' };
      useDate = true;
    } else if (tokenTimeframe === '365d') {
      start = end - 365 * 24 * 60 * 60 * 1000;
      labelFormat = { month: 'short' };
      useDate = true;
    }

    const range = end - start;
    const bucketCount = 8;
    const bucketSize = range / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => {
      const bucketStart = start + i * bucketSize;
      const bucketEnd = start + (i + 1) * bucketSize;
      const midTime = bucketStart + bucketSize / 2;
      const dateObj = new Date(midTime);
      const label = useDate 
        ? dateObj.toLocaleDateString([], labelFormat) 
        : dateObj.toLocaleTimeString([], labelFormat);
      return {
        startTime: bucketStart,
        endTime: bucketEnd,
        value: 0,
        label
      };
    });

    tokenData.graphData.forEach(d => {
      const time = new Date(d.created_at).getTime();
      const idx = Math.floor((time - start) / bucketSize);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].value += d.token_count;
      }
    });

    return buckets;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Timeframe Selector and KPI Row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <div className="sub-tab-buttons" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {[
            { id: 'last_request', name: 'Last Request' },
            { id: '1h', name: 'Last Hour' },
            { id: '12h', name: 'Last 12 Hours' },
            { id: '24h', name: 'Last 24 Hours' },
            { id: '7d', name: 'Last Week' },
            { id: '30d', name: 'Last Month' },
            { id: '365d', name: 'Last Year' }
          ].map(t => (
            <button
              key={t.id}
              className={`btn btn-secondary ${tokenTimeframe === t.id ? 'active' : ''}`}
              onClick={() => setTokenTimeframe(t.id)}
              style={{ padding: '6px 12px', fontSize: '0.8rem' }}
            >
              {t.name}
            </button>
          ))}
        </div>

        {/* Quick refresh button */}
        <button 
          className="btn btn-secondary" 
          onClick={() => fetchTokenData(tokenTimeframe)}
          disabled={loadingTokens}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', padding: '6px 12px' }}
        >
          <RefreshCw size={14} className={loadingTokens ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Overall Token Count Card */}
      <div className="memory-card" style={{ padding: '20px', display: 'flex', alignItems: 'center', gap: '20px', background: 'var(--bg-glass)', border: '1px solid var(--border-glass)', borderRadius: '16px', boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.2)' }}>
        <div style={{ background: 'var(--accent-glow)', padding: '12px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <BarChart2 size={32} style={{ color: 'var(--accent-primary)' }} />
        </div>
        <div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 550, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Overall Token Count</div>
          <div style={{ fontSize: '2.2rem', fontWeight: 800, color: '#fff', marginTop: '4px', textShadow: '0 0 10px var(--accent-glow)' }}>
            {tokenData && typeof tokenData.totalTokens === 'number' ? tokenData.totalTokens.toLocaleString() : 0}
          </div>
        </div>
      </div>

      {/* Grid containing Chart and Data Table */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px' }}>
        {/* Chart Card */}
        <div className="memory-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 style={{ fontSize: '1.05rem', color: '#fff', fontWeight: 600 }}>Token Usage Timeline</h3>
          {loadingTokens ? (
            <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
              <RefreshCw size={24} className="animate-spin" />
            </div>
          ) : (
            <TokenChart data={getBucketedGraphData()} />
          )}
        </div>

        {/* Data Table Card */}
        <div className="memory-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 style={{ fontSize: '1.05rem', color: '#fff', fontWeight: 600 }}>Usage by Model</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}>
                  <th style={{ padding: '10px 8px', fontWeight: 600 }}>Model</th>
                  <th style={{ padding: '10px 8px', fontWeight: 600 }}>Local or Online</th>
                  <th style={{ padding: '10px 8px', fontWeight: 600, textAlign: 'right' }}>Tokens</th>
                  <th style={{ padding: '10px 8px', fontWeight: 600, textAlign: 'right' }}>% of Total</th>
                </tr>
              </thead>
              <tbody>
                {tokenData && tokenData.tableData && tokenData.tableData.length > 0 ? (
                  tokenData.tableData.map((item, idx) => {
                    const pct = tokenData.totalTokens > 0 
                      ? ((item.total_tokens / tokenData.totalTokens) * 100).toFixed(1) + '%'
                      : '0.0%';
                    return (
                      <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', color: 'var(--text-primary)' }}>
                        <td style={{ padding: '10px 8px', fontWeight: 500 }}>{item.model_name}</td>
                        <td style={{ padding: '10px 8px' }}>
                          <span className={`badge ${item.provider_type === 'online' ? 'badge-short-term' : 'badge-long-term'}`} style={{ fontSize: '0.7rem', padding: '2px 8px', textTransform: 'capitalize' }}>
                            {item.provider_type === 'online' ? 'Online' : 'Local'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 8px', textAlign: 'right', fontFamily: 'monospace' }}>{item.total_tokens ? item.total_tokens.toLocaleString() : 0}</td>
                        <td style={{ padding: '10px 8px', textAlign: 'right', fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{pct}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan="4" style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
                      {loadingTokens ? 'Loading data...' : 'No token usage recorded for this timeframe.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
