// Today's Shipping Queue — live live classification for operational view
// Groups: carryover (2+d), late (1d), shipToday (greenlit prev-day + today new)
// Differs from sync review:
// - POS no-tracking-past rule does NOT apply (today's action window is live)
// - Riskified::submitted stays visible (surfaced with WAITING badge, not auto-skipped)
// - Pending orders filtered out (same as sync review)
// - manualExclusions NOT applied (different context — this is live, not historical)
// - Saturday: orders >= $5k filtered out (insurance rule, May 2026)

const RISKIFIED_APPROVED  = 'riskified::approved';
const RISKIFIED_SUBMITTED = 'riskified::submitted';
const RISKIFIED_DECLINED  = 'riskified::declined';
const GREENLIT_TAGS = ['protected', RISKIFIED_APPROVED];
const HIGH_VALUE_THRESHOLD = 5000; // Saturday insurance rule

const FIREBASE_URL = 'https://ops-hub-1122d-default-rtdb.firebaseio.com';
const FIREBASE_KEY = 'AIzaSyClTXv6C_SDtwEzZ9DN4ZOTf8ocA4ni8hY';

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const shop         = process.env.SHOPIFY_SHOP || 'showroomla.myshopify.com';
  if (!clientId || !clientSecret) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET required' }) };
  }

  try {
    // Date anchor: TODAY in PT
    const now = new Date();
    const ptDateStr = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).toISOString().split('T')[0];
    // Cutoff 3pm PT today
    const offsetStr = (function() {
      try {
        const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' });
        const parts = dtf.formatToParts(now);
        const tz = parts.find(function(p) { return p.type === 'timeZoneName'; });
        if (tz && tz.value) {
          const m = tz.value.match(/([+-])(\d{1,2})/);
          if (m) return m[1] + String(m[2]).padStart(2, '0') + ':00';
        }
      } catch(e) {}
      return '-08:00';
    })();

    const todayCutoff = new Date(ptDateStr + 'T15:00:00' + offsetStr);
    const todayEOD    = new Date(ptDateStr + 'T23:59:59' + offsetStr);

    // Pull orders from last 14 days (catches carryover + today's new)
    const lookback = new Date(now); lookback.setDate(lookback.getDate() - 14);
    const createdMin = lookback.toISOString();

    // Get OAuth access token (same flow as manual sync)
    const token = await getAccessToken(shop, clientId, clientSecret);

    const url = 'https://' + shop + '/admin/api/2026-04/orders.json'
      + '?status=any'
      + '&fulfillment_status=unfulfilled'
      + '&financial_status=any'
      + '&limit=250'
      + '&created_at_min=' + encodeURIComponent(createdMin)
      + '&fields=id,name,created_at,financial_status,fulfillment_status,fulfillments,tags,customer,email,source_name,cancelled_at,line_items,shipping_address,shipping_lines,total_price';

    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
    if (!resp.ok) {
      const text = await resp.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Shopify fetch failed: ' + resp.status, detail: text.substring(0, 500) }) };
    }
    const data = await resp.json();
    const orders = Array.isArray(data.orders) ? data.orders : [];

    // Load pending items to exclude
    let pendingIds = new Set();
    try {
      const pResp = await fetch(FIREBASE_URL + '/auth/pendingItems.json?auth=' + FIREBASE_KEY);
      if (pResp.ok) {
        const pData = await pResp.json();
        if (pData && typeof pData === 'object') {
          Object.keys(pData).forEach(function(k) {
            const item = pData[k];
            if (item && !item.resolved) pendingIds.add(String(item.shopifyId || k));
          });
        }
      }
    } catch(e) { console.error('pending fetch error:', e); }

    const classified = classify(orders, todayCutoff, todayEOD, ptDateStr, pendingIds, offsetStr);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        date: ptDateStr,
        fetchedAt: now.toISOString(),
        summary: {
          carryover:      classified.carryover.length,
          late:           classified.late.length,
          shipTodayGreenlit: classified.shipTodayGreenlit.length,
          shipTodayNew:   classified.shipTodayNew.length,
          shipTodayTotal: classified.shipTodayGreenlit.length + classified.shipTodayNew.length,
          pending:        pendingIds.size,
          waiting:        classified.waiting.length
        },
        carryover:         classified.carryover,
        late:              classified.late,
        shipTodayGreenlit: classified.shipTodayGreenlit,
        shipTodayNew:      classified.shipTodayNew,
        waiting:           classified.waiting
      })
    };
  } catch(err) {
    console.error('todays-queue error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal error' }) };
  }
};



async function getAccessToken(shop, clientId, clientSecret) {
  try {
    const res = await fetch('https://' + shop + '/admin/oauth/access_token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' })
    });
    if (res.ok) { const d = await res.json(); if (d.access_token) return d.access_token; }
  } catch(e) {}
  return clientSecret;
}

function getTags(order) {
  if (!order || !order.tags) return [];
  return order.tags.toLowerCase().split(',').map(function(t) { return t.trim(); });
}
function getCustomerName(o) {
  if (!o) return 'Unknown';
  if (o.customer) {
    const f = o.customer.first_name || ''; const l = o.customer.last_name || '';
    const name = (f + ' ' + l).trim(); if (name) return name;
  }
  return o.email || 'Unknown';
}
function daysBetween(aStr, bStr) {
  try {
    const a = new Date(aStr + 'T12:00:00Z'); const b = new Date(bStr + 'T12:00:00Z');
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
  } catch(e) { return 0; }
}

function classify(orders, todayCutoff, todayEOD, todayDateStr, pendingIds, offsetStr) {
  const carryover = [], late = [], shipTodayGreenlit = [], shipTodayNew = [], waiting = [];

  // Detect Saturday (PT) for high-value insurance rule
  var todayIsSaturday = false;
  try {
    if (todayDateStr) {
      var dCheck = new Date(todayDateStr + 'T12:00:00-08:00');
      todayIsSaturday = dCheck.getUTCDay() === 6;
    }
  } catch(e) { todayIsSaturday = false; }
  if (todayIsSaturday) console.log('[SATURDAY_RULE_ACTIVE] today=' + todayDateStr + ' threshold=$' + HIGH_VALUE_THRESHOLD);

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    if (!order) continue;

    // Skip cancelled
    if (order.cancelled_at) continue;
    // Skip fulfilled (tracking exists)
    let wasShipped = false;
    try {
      if (Array.isArray(order.fulfillments)) {
        for (let fi = 0; fi < order.fulfillments.length; fi++) {
          const ff = order.fulfillments[fi]; if (!ff) continue;
          if (ff.tracking_number || ff.tracking_url || (Array.isArray(ff.tracking_numbers) && ff.tracking_numbers.length)) { wasShipped = true; break; }
        }
      }
    } catch(e) { wasShipped = false; }
    if (wasShipped) continue;

    // Skip if in pending
    const idStr = String(order.id || '');
    const nameStr = String(order.name || '');
    if (pendingIds.has(idStr) || pendingIds.has(nameStr)) continue;

    // Skip if no shipping address AND no tracking (in-store pickup, already shipped)
    const hasShippingAddr = !!(order.shipping_address && order.shipping_address.address1);
    if (!hasShippingAddr) continue; // nothing to ship

    const tags = getTags(order);

    // Tag precedence (Riskified-only, May 2026 cleanup)
    const hasRiskifiedSubmitted = tags.indexOf(RISKIFIED_SUBMITTED) > -1;
    const hasRiskifiedDeclined  = tags.indexOf(RISKIFIED_DECLINED)  > -1;

    let waitingReason = null;
    if (hasRiskifiedDeclined) {
      // Riskified says no — skip entirely
      continue;
    } else if (hasRiskifiedSubmitted) {
      // Waiting on decision — surface in WAITING bucket
      waitingReason = 'Riskified::submitted';
    }

    const hasGreenlitTag = tags.some(function(t) { return GREENLIT_TAGS.includes(t); });
    const payStatus = order.financial_status;
    const paymentOk = (payStatus === 'paid' || payStatus === 'authorized');
    if (!paymentOk) continue;

    // Saturday insurance rule: orders >= $5k cannot ship Saturday (no Sunday delivery)
    if (todayIsSaturday) {
      var orderTotal = parseFloat(order.total_price) || 0;
      if (orderTotal >= HIGH_VALUE_THRESHOLD) {
        console.log('[SKIP_SATURDAY_HIGH_VALUE]', order.name, '$' + orderTotal.toFixed(2));
        continue;
      }
    }

    const createdAt = new Date(order.created_at);
    const createdDayStr = createdAt.toISOString().split('T')[0];
    const createdPTDay = new Date(createdAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).toISOString().split('T')[0];
    const daysLate = daysBetween(createdPTDay, todayDateStr);

    const row = {
      id:           String(order.id || ''),
      order:        order.name || ('#' + (order.id || '')),
      customer:     getCustomerName(order),
      total:        order.total_price || '',
      createdAt:    order.created_at,
      createdPTDay: createdPTDay,
      daysLate:     daysLate,
      hasGreenlit:  hasGreenlitTag,
      greenlitTag:  hasGreenlitTag ? (GREENLIT_TAGS.find(function(t) { return tags.includes(t); }) || '') : '',
      tags:         tags.slice(0, 8),
      source:       order.source_name || '',
      financialStatus: payStatus || '',
      shippingMethod: (order.shipping_lines && order.shipping_lines[0] && order.shipping_lines[0].title) || '',
      waiting:      !!waitingReason,
      waitingReason: waitingReason || ''
    };

    // Waiting bucket is separate — skipped from ship-today lists
    if (waitingReason) {
      waiting.push(row);
      continue;
    }

    // Classify by days late
    if (daysLate >= 2) {
      carryover.push(row);
    } else if (daysLate === 1) {
      late.push(row);
    } else if (daysLate === 0) {
      // Today — split by greenlit status
      // If greenlit (prev-day leftover greenlit doesn't apply since createdPTDay === today), push to new
      // Actually: daysLate=0 = created today, so goes to "today's new"
      shipTodayNew.push(row);
    } else {
      // daysLate < 0 means future-dated (edge case, shouldn't happen)
      continue;
    }
  }

  // Prev-day-after-cutoff greenlit orders are CARRIED into shipTodayGreenlit
  // These are orders created yesterday after 3pm PT, have greenlit tag, eligible for today
  // We already counted them as daysLate=1 so they're in "late" bucket — need to move them
  const prevDayStr = (function() {
    try {
      const d = new Date(todayDateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().split('T')[0];
    } catch(e) { return ''; }
  })();

  // Move prev-day greenlit orders created after 3pm from "late" to "shipTodayGreenlit"
  for (let j = late.length - 1; j >= 0; j--) {
    const r = late[j];
    if (r.createdPTDay === prevDayStr && r.hasGreenlit) {
      try {
        const ca = new Date(r.createdAt);
        // Previous day's 3pm PT cutoff
        const prevCutoff = new Date(prevDayStr + 'T15:00:00' + offsetStr);
        if (ca >= prevCutoff) {
          shipTodayGreenlit.push(r);
          late.splice(j, 1);
        }
      } catch(e) {}
    }
  }

  // Sort: carryover oldest first (most urgent), late newest first, ship today by createdAt
  carryover.sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  late.sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  shipTodayGreenlit.sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  shipTodayNew.sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  waiting.sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });

  return { carryover: carryover, late: late, shipTodayGreenlit: shipTodayGreenlit, shipTodayNew: shipTodayNew, waiting: waiting };
}
