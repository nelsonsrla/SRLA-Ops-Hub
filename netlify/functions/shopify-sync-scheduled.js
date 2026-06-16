// shopify-sync-scheduled.js v7
// Runs 14:00 UTC Mon-Sat (6am PT winter / 7am PT summer)
// Three-query logic matching manual sync v7

// Tag constants — Riskified is the sole source of truth for tag-based decisions.
// 'protected' is preserved as a manual greenlit override.
const RISKIFIED_APPROVED  = 'riskified::approved';
const RISKIFIED_SUBMITTED = 'riskified::submitted';
const RISKIFIED_DECLINED  = 'riskified::declined';
const GREENLIT_TAGS = ['protected', RISKIFIED_APPROVED];
const SKIP_TAGS     = [RISKIFIED_SUBMITTED, RISKIFIED_DECLINED];
const HIGH_VALUE_THRESHOLD = 5000; // Saturday insurance rule: orders >= this are deferred to Monday
const FIREBASE_URL  = 'https://ops-hub-1122d-default-rtdb.firebaseio.com';
const FIREBASE_KEY  = 'AIzaSyClTXv6C_SDtwEzZ9DN4ZOTf8ocA4ni8hY';

exports.handler = async function(event, context) {
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const shop         = process.env.SHOPIFY_SHOP || 'showroomla.myshopify.com';

  const now       = new Date();
  const ptOffset  = getPacificOffset(now);
  const ptNow     = new Date(now.getTime() + ptOffset * 60 * 60 * 1000);
  const todayStr  = ptNow.toISOString().split('T')[0];
  const dayOfWeek = ptNow.getUTCDay();

  try {
    if (!clientId || !clientSecret) {
      await logError('Missing credentials', todayStr);
      return { statusCode: 500, body: 'Missing credentials' };
    }

    // Always process yesterday. Each run covers the prior day's shipping review.
    // Mon 7am → reviews Sunday (Not Packed review)
    // Tue 7am → reviews Monday
    // Sat 7am → reviews Friday
    // No Sunday run (cron skips Sunday)
    const targetDates = [];
    const y = new Date(ptNow); y.setUTCDate(y.getUTCDate() - 1);
    targetDates.push(y.toISOString().split('T')[0]);

    const token = await getAccessToken(shop, clientId, clientSecret);
    const pendingItems = await readFirebase('auth/pendingItems') || {};
    const pendingOrderIds = Object.keys(pendingItems);

    // Fetch all unfulfilled ONCE (used across all target dates)
    const unfulfilledOrders = await fetchAllUnfulfilled(shop, token);

    const results = [];
    for (const dateStr of targetDates) {
      try {
        const offsetStr   = formatOffset(ptOffset);
        const targetCutoff     = new Date(dateStr + 'T15:00:00' + offsetStr); // 3pm — eligibility cutoff
        const targetLateCutoff = new Date(dateStr + 'T17:00:00' + offsetStr); // 5pm — UPS/FedEx pickup, on-time/late split
        const targetEOD        = new Date(dateStr + 'T23:59:59' + offsetStr);
        const targetSOD        = new Date(dateStr + 'T00:00:00' + offsetStr);

        const prevDay = new Date(targetSOD); prevDay.setDate(prevDay.getDate() - 1);
        const prevDayStr = prevDay.toISOString().split('T')[0];
        let prevAfter  = new Date(prevDayStr + 'T15:00:00' + offsetStr);
        const prevEOD  = new Date(prevDayStr + 'T23:59:59' + offsetStr);

        // Monday target: extend weekend window back to Saturday 3pm PT
        // (nothing ships Sunday, so Sat-after-3pm and all-Sunday orders roll into Monday's eligible pool)
        let isMondayTarget = false;
        try {
          const targetDow = new Date(dateStr + 'T12:00:00' + offsetStr).getUTCDay();
          isMondayTarget = targetDow === 1;
          if (isMondayTarget) {
            const satDate = new Date(prevDay);
            satDate.setDate(satDate.getDate() - 1);
            const satDateStr = satDate.toISOString().split('T')[0];
            prevAfter = new Date(satDateStr + 'T15:00:00' + offsetStr);
            console.log('[MONDAY_WEEKEND_WINDOW]', 'window extended to', satDateStr, '15:00 PT');
          }
        } catch(e) { console.error('Monday detection failed:', e); }

        const [todayOrders, prevGreenlit] = await Promise.all([
          fetchOrdersByDate(shop, token, targetSOD.toISOString(), targetCutoff.toISOString()),
          fetchOrdersByDate(shop, token, prevAfter.toISOString(), prevEOD.toISOString())
        ]);

        const merged = dedupeOrders([].concat(unfulfilledOrders, todayOrders, prevGreenlit));
        const analyzed = analyze(merged, targetCutoff, targetLateCutoff, targetEOD, dateStr, prevDayStr, pendingOrderIds);

        const summary = {
          eligible:     analyzed.eligible.length,
          late:         analyzed.late.length,
          onTime:       analyzed.onTime.length,
          greenlitLate: analyzed.greenlitLate.length,
          totalLate:    analyzed.late.length + analyzed.greenlitLate.length,
          pendingCount: analyzed.pending.length
        };

        const fields = {
          shp_orders_eligible: { shopify: summary.eligible, type: 'count' },
          shp_green_packed:    { shopify: summary.totalLate === 0 ? 'Y' : 'N', type: 'yn' },
          shp_on_time:         { shopify: summary.totalLate === 0 ? 'Y' : 'N', type: 'yn' },
          shp_late:            { shopify: summary.totalLate, type: 'count' },
        };

        // Merge with existing entry to preserve review history
        const existing = await readFirebase('auth/syncHistory/' + dateStr);
        const wasReviewed = existing && existing.status === 'reviewed';
        const entryToWrite = {
          date:         dateStr,
          scheduledAt:  now.toISOString(),
          type:         (existing && existing.type === 'manual') ? 'manual→scheduled' : 'scheduled',
          status:       wasReviewed ? 'reviewed' : 'pending_review',
          location:     'SRLA_HQ',
          summary,
          fields,
          eligibleOrders: analyzed.eligible.slice(0, 100),
          lateOrders:     analyzed.late.slice(0, 50),
          greenlitLate:   analyzed.greenlitLate.slice(0, 20),
          manualExclusions: (existing && Array.isArray(existing.manualExclusions)) ? existing.manualExclusions : [],
          reviewedBy:   wasReviewed ? (existing.reviewedBy || null) : null,
          reviewedAt:   wasReviewed ? (existing.reviewedAt || null) : null
        };
        await writeFirebase('auth/syncHistory/' + dateStr, entryToWrite);

        // Auto-resolve pending items that are now fulfilled
        for (const orderId of pendingOrderIds) {
          const order = unfulfilledOrders.find(function(o) { return String(o.id) === String(orderId); });
          // Not in unfulfilled list = fulfilled
          if (!order) {
            const pItem = pendingItems[orderId];
            if (pItem && !pItem.resolved) {
              await writeFirebase('auth/pendingItems/' + orderId + '/resolved', {
                resolvedAt: now.toISOString(),
                resolvedBy: 'system',
                reason: 'Fulfilled in Shopify'
              });
            }
          }
        }

        results.push({ date: dateStr, success: true, summary });
      } catch(dateErr) {
        await logError('Date ' + dateStr + ': ' + dateErr.message, dateStr);
        results.push({ date: dateStr, error: dateErr.message });
      }
    }

    // ── Sales Insights pool-sales cache (Phase 1A.1) ──────────────────────
    // Independent of the date-by-date sync above. Pulls last 14 days of pool-tagged
    // orders and refreshes the salesInsights cache. Handles the "tag added late"
    // edge case per the 14-day rolling window decision.
    try {
      const salesResult = await syncSalesInsightsPool(shop, token);
      console.log('[SALES_INSIGHTS] cached', salesResult.ordersCached, 'pool orders');
      await writeFirebase('ops_data/salesInsights/syncMeta/lastShopifySync', {
        ts: Date.now(),
        date: todayStr,
        ordersCached: salesResult.ordersCached,
        windowDays: 14
      });
    } catch(salesErr) {
      console.error('Sales Insights sync failed:', salesErr.message);
      await logError('Sales Insights pool sync: ' + salesErr.message, todayStr).catch(function() {});
    }

    console.log('Scheduled sync complete:', JSON.stringify(results));
    return { statusCode: 200, body: JSON.stringify({ success: true, results }) };
  } catch(err) {
    console.error('Scheduled sync fatal:', err);
    await logError(err.message || 'Unknown', todayStr).catch(function() {});
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Analysis (same as manual v6) ─────────────────────────────────────────────

function analyze(orders, targetCutoff, targetLateCutoff, targetEOD, targetDateStr, prevDateStr, pendingOrderIds) {
  const eligible = [], late = [], onTime = [], greenlitLate = [], pending = [];
  const pendingSet = new Set((pendingOrderIds || []).map(function(x) { return String(x); }));

  // Detect if target date is Saturday (PT) — drives high-value insurance rule
  var targetIsSaturday = false;
  try {
    if (targetDateStr) {
      var dCheck = new Date(targetDateStr + 'T12:00:00-08:00');
      targetIsSaturday = dCheck.getUTCDay() === 6;
    }
  } catch(e) { targetIsSaturday = false; }
  if (targetIsSaturday) console.log('[SATURDAY_RULE_ACTIVE] target=' + targetDateStr + ' threshold=$' + HIGH_VALUE_THRESHOLD);

  for (const order of orders) {
    if (!order || !order.created_at) continue;
    // Skip cancelled orders
    if (order.cancelled_at) { console.log('[SKIP_CANCELLED]', order.name); continue; }
    // Shipping-needed check: order qualifies only if it actually needs shipping.
    // Has tracking number OR has shipping address = real shipping order.
    // POS in-store pickups fail both checks and get skipped.
    var wasShipped = false;
    try {
      if (Array.isArray(order.fulfillments)) {
        for (var fi = 0; fi < order.fulfillments.length; fi++) {
          var ff = order.fulfillments[fi];
          if (!ff) continue;
          if (ff.tracking_number || ff.tracking_url) { wasShipped = true; break; }
          if (Array.isArray(ff.tracking_numbers) && ff.tracking_numbers.length > 0) { wasShipped = true; break; }
          if (Array.isArray(ff.tracking_urls) && ff.tracking_urls.length > 0) { wasShipped = true; break; }
        }
      }
    } catch(e) { wasShipped = false; }
    var hasShippingAddr = !!(order.shipping_address && order.shipping_address.address1);
    if (!wasShipped && !hasShippingAddr) {
      console.log('[SKIP_NO_SHIPPING_NEEDED]', order.name, '(no tracking, no shipping address — POS pickup)');
      continue;
    }

    // POS + no tracking + past date = in-store pickup classification, auto-skip
    // Only applies when target date's action window has closed (reviewing past data)
    // For today/future (Today's Queue), POS-no-tracking stays surfaced for rep action
    var isPosOrder = /pos/i.test(order.source_name || '');
    if (isPosOrder && !wasShipped) {
      var targetIsPast = false;
      try {
        var nowPT = new Date().toISOString().split('T')[0];
        targetIsPast = targetDateStr < nowPT;
      } catch(e) { targetIsPast = false; }
      if (targetIsPast) {
        console.log('[SKIP_POS_NO_TRACKING_PAST]', order.name, 'target=' + targetDateStr);
        continue;
      }
    }
    const tags = getTags(order);
    // Tag precedence (Riskified-only, May 2026 cleanup):
    // - Riskified::approved → proceed normally
    // - Riskified::declined or ::submitted → skip
    // - No Riskified tag → fall through, payment gate decides
    if (tags.indexOf(RISKIFIED_DECLINED) > -1 || tags.indexOf(RISKIFIED_SUBMITTED) > -1) {
      console.log('[SKIP_RISKIFIED]', order.name, tags.indexOf(RISKIFIED_DECLINED) > -1 ? 'declined' : 'submitted');
      continue;
    }

    const hasGreenlitTag = tags.some(function(t) { return GREENLIT_TAGS.includes(t); });
    const payStatus = order.financial_status;
    const paymentOk = (payStatus === 'paid' || payStatus === 'authorized');
    if (!paymentOk) { console.log('[SKIP_PAYMENT]', order.name, 'status='+(order.financial_status||'null')); continue; }

    // Saturday insurance rule: orders >= $5k cannot ship Saturday (no Sunday delivery)
    if (targetIsSaturday) {
      var orderTotal = parseFloat(order.total_price) || 0;
      if (orderTotal >= HIGH_VALUE_THRESHOLD) {
        console.log('[SKIP_SATURDAY_HIGH_VALUE]', order.name, '$' + orderTotal.toFixed(2));
        continue;
      }
    }

    const createdAt = new Date(order.created_at);
    const customer  = getCustomerName(order);
    const label     = order.name + ' \u2014 ' + customer;
    const createdDayStr = createdAt.toISOString().split('T')[0];

    const isBeforeCutoff = createdAt < targetCutoff;
    const isPrevAfterCutoff = createdDayStr === prevDateStr && !isBeforeCutoff;
    // Qualify rule: order was in target window, can ship (payment/greenlit already validated above)
    // Non-greenlit prev-day-after-cutoff orders still qualify — they physically need to ship today
    const qualifies = isBeforeCutoff || isPrevAfterCutoff;
    if (!qualifies) { console.log('[SKIP_NOT_ELIGIBLE]', order.name, 'created='+order.created_at); continue; }

    let fulfilledByEOD = false, fulfilledOnTime = false, fulfillmentAt = null;
    if (order.fulfillment_status === 'fulfilled') {
      const lf = getLastFulfillment(order);
      if (lf && lf.created_at) {
        fulfillmentAt = new Date(lf.created_at);
        if (fulfillmentAt <= targetEOD) {
          fulfilledByEOD = true;
          fulfilledOnTime = fulfillmentAt <= targetLateCutoff;
        }
      }
    }

    const isCarryover = createdDayStr < targetDateStr;
    const daysLate    = isCarryover ? daysBetween(createdDayStr, targetDateStr) : 0;
    const isPending   = pendingSet.has(String(order.id)) || pendingSet.has(order.name);

    const row = {
      id: order.id, order: order.name, customer, label,
      created: order.created_at, createdAt: order.created_at, createdDay: createdDayStr,
      isCarryover, daysLate,
      hasGreenlit: hasGreenlitTag,
      greenlitTag: hasGreenlitTag ? (GREENLIT_TAGS.find(function(t) { return tags.includes(t); }) || '') : '',
      isPrevDayGreenlit: isPrevAfterCutoff && hasGreenlitTag,
      source:          order.source_name || '',
      financialStatus: order.financial_status || '',
      fulfilled:       order.fulfillment_status === 'fulfilled',
      fulfilledAt:     fulfillmentAt ? fulfillmentAt.toISOString() : null,
      tags:            tags.slice(0, 10)
    };

    eligible.push(row);

    if (!fulfilledByEOD) {
      if (isPending) {
        pending.push(Object.assign({}, row, { reason: 'In pending items' }));
      } else if (row.isPrevDayGreenlit) {
        greenlitLate.push(Object.assign({}, row, {
          reason: 'Greenlit (' + row.greenlitTag + ') \u2014 from ' + prevDateStr + ' \u2014 ship today'
        }));
      } else {
        const reason = isCarryover
          ? 'Carryover from ' + createdDayStr + ' (' + daysLate + 'd late) \u2014 Unfulfilled'
          : 'Unfulfilled';
        const lateRow = Object.assign({}, row, { reason });
        if (hasGreenlitTag) {
          greenlitLate.push(Object.assign({}, lateRow, {
            reason: 'Greenlit (' + row.greenlitTag + ')' + (isCarryover ? ' \u2014 ' + daysLate + 'd late' : '') + ' \u2014 Unfulfilled'
          }));
        } else {
          late.push(lateRow);
        }
      }
    } else if (fulfilledOnTime) {
      onTime.push(row);
    } else {
      const timeStr = formatTime(fulfillmentAt, 'America/Los_Angeles');
      const reason = isCarryover
        ? 'Carryover from ' + createdDayStr + ' (' + daysLate + 'd late) \u2014 Fulfilled at ' + timeStr
        : 'Fulfilled late at ' + timeStr;
      const lateRow = Object.assign({}, row, { reason });
      if (hasGreenlitTag) {
        greenlitLate.push(Object.assign({}, lateRow, {
          reason: 'Greenlit (' + row.greenlitTag + ')' + (isCarryover ? ' \u2014 ' + daysLate + 'd late' : '') + ' \u2014 Fulfilled at ' + timeStr
        }));
      } else {
        late.push(lateRow);
      }
    }
  }

  return { eligible, late, onTime, greenlitLate, pending };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchAllUnfulfilled(shop, token) {
  const all = [];
  let url = 'https://' + shop + '/admin/api/2026-04/orders.json?' + new URLSearchParams({
    status: 'any', fulfillment_status: 'unfulfilled', limit: '250',
    fields: 'id,name,created_at,financial_status,fulfillment_status,fulfillments,tags,customer,email,source_name,cancelled_at,line_items,shipping_address,total_price'
  }).toString();
  let pages = 0;
  while (url && pages < 10) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
    if (!res.ok) {
      const t = await res.text().catch(function() { return ''; });
      throw new Error('Shopify unfulfilled API ' + res.status + ': ' + t.substring(0, 200));
    }
    const data = await res.json();
    if (Array.isArray(data.orders)) for (const o of data.orders) all.push(o);
    const linkHdr = res.headers.get('link') || res.headers.get('Link') || '';
    const nextMatch = linkHdr.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    pages++;
  }
  return all;
}

async function fetchOrdersByDate(shop, token, minISO, maxISO) {
  const params = new URLSearchParams({
    status: 'any', limit: '250',
    fields: 'id,name,created_at,financial_status,fulfillment_status,fulfillments,tags,customer,email,source_name,cancelled_at,line_items,shipping_address,total_price',
    created_at_min: minISO, created_at_max: maxISO
  });
  const res = await fetch('https://' + shop + '/admin/api/2026-04/orders.json?' + params.toString(),
    { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const t = await res.text().catch(function() { return ''; });
    throw new Error('Shopify date API ' + res.status + ': ' + t.substring(0, 200));
  }
  const data = await res.json();
  return Array.isArray(data.orders) ? data.orders : [];
}

function dedupeOrders(orders) {
  const seen = new Set(); const result = [];
  for (const o of orders) {
    if (!o || !o.id) continue;
    const key = String(o.id);
    if (seen.has(key)) continue;
    seen.add(key); result.push(o);
  }
  return result;
}

// ── Firebase helpers ──────────────────────────────────────────────────────────

async function writeFirebase(path, data) {
  const url = FIREBASE_URL + '/' + path + '.json?auth=' + FIREBASE_KEY;
  const res = await fetch(url, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error('Firebase write failed: ' + res.status);
  return res.json();
}

async function readFirebase(path) {
  try {
    const url = FIREBASE_URL + '/' + path + '.json?auth=' + FIREBASE_KEY;
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch(e) { return null; }
}

async function logError(message, dateStr) {
  try {
    const ts = Date.now();
    await writeFirebase('auth/syncErrors/' + ts, {
      message, date: dateStr || 'unknown', ts, type: 'scheduled'
    });
  } catch(e) { console.error('Could not log error:', e.message); }
}

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

// ── Field helpers ────────────────────────────────────────────────────────────

function getTags(order) {
  if (!order || !order.tags) return [];
  return order.tags.toLowerCase().split(',').map(function(t) { return t.trim(); });
}

function getCustomerName(o) {
  if (!o) return 'Unknown';
  if (o.customer) {
    const n = ((o.customer.first_name||'') + ' ' + (o.customer.last_name||'')).trim();
    if (n) return n;
  }
  return o.email || 'Unknown';
}

function getLastFulfillment(o) {
  if (!o || !Array.isArray(o.fulfillments) || !o.fulfillments.length) return null;
  return o.fulfillments[o.fulfillments.length - 1];
}

function formatTime(d, tz) {
  try { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }); }
  catch(e) { return d.toISOString(); }
}

function daysBetween(startStr, endStr) {
  try {
    const s = new Date(startStr + 'T00:00:00Z');
    const e = new Date(endStr + 'T00:00:00Z');
    return Math.round((e - s) / 86400000);
  } catch(e) { return 0; }
}

function getPacificOffset(d) {
  const y = d.getFullYear();
  const s = getNth(y, 3, 2); const e = getNth(y, 11, 1);
  return (d >= s && d < e) ? -7 : -8;
}
function getNth(y, m, n) {
  const d = new Date(y, m - 1, 1);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7) + (n - 1) * 7);
  return d;
}
function formatOffset(h) {
  return (h < 0 ? '-' : '+') + String(Math.abs(Math.floor(h))).padStart(2, '0') + ':00';
}

// ── Sales Insights — Pool Sales Cache (Phase 1A.1) ────────────────────────────
// Pulls last 14 days of pool-tagged orders and caches per-order data for the
// Sales Insights tab. Handles the late-tag edge case via 14-day rolling window.
// Writes:
//   ops_data/salesInsights/orders/{order_id}
//   ops_data/salesInsights/repTotals/{rep_id}/{period_id}
//   ops_data/salesInsights/quarterly/{rep_id}/{quarter_id}

const POOL_TAG = 'POOL SRLA';
const TRACKED_REPS = ['Yoni', 'Leanna', 'Lillie'];
// Brandon Love name normalization concept — apply same fix here
function normalizeRepName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Take the first word for matching ("Yoni Messay" → "Yoni", "Brandon Love" → "Brandon")
  const firstWord = trimmed.split(/\s+/)[0];
  // Case-insensitive match against tracked reps list
  for (const rep of TRACKED_REPS) {
    if (firstWord.toLowerCase() === rep.toLowerCase()) return rep;
  }
  return null;
}

function hasPoolTag(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(function(t) {
    return typeof t === 'string' && t.trim().toUpperCase() === POOL_TAG;
  });
}

// Determine which quarter a date falls in (Q1=Jan-Mar, etc.)
function quarterKeyFor(dateStr) {
  const d = new Date(dateStr);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return d.getUTCFullYear() + '-Q' + q;
}

// Day key in YYYY-MM-DD format from any date string/Date
function dayKeyFor(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().split('T')[0];
}

// Net sales for an order: subtotal_price minus refunds (Phase 1A definition)
// Refunds are reduced via Shopify's refunds[].transactions, summing kind:refund amounts
function netSalesFor(order) {
  if (!order) return 0;
  const subtotal = parseFloat(order.subtotal_price) || 0;
  let refundTotal = 0;
  if (Array.isArray(order.refunds)) {
    for (const r of order.refunds) {
      if (Array.isArray(r.transactions)) {
        for (const tx of r.transactions) {
          if (tx && tx.kind === 'refund') refundTotal += (parseFloat(tx.amount) || 0);
        }
      }
    }
  }
  return Math.max(0, subtotal - refundTotal);
}

// Identify who closed this sale — checks Shopify's user_id mapping, falls back to staff_name
// Per spec answer: name match against rep roster. Returns normalized name or null.
function identifyRepFor(order, staffById) {
  // Try several fields where Shopify stores user data
  let candidate = null;
  if (order.user_id && staffById && staffById[order.user_id]) {
    candidate = staffById[order.user_id];
  }
  // POS order's source_identifier or note_attributes can also indicate staff
  if (!candidate && Array.isArray(order.note_attributes)) {
    for (const na of order.note_attributes) {
      if (na && /staff|associate|rep/i.test(na.name || '')) {
        candidate = na.value;
        break;
      }
    }
  }
  return normalizeRepName(candidate);
}

async function syncSalesInsightsPool(shop, token) {
  // Compute 14-day window (UTC for API call, will dedupe later)
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - 14);
  windowStart.setUTCHours(0, 0, 0, 0);

  // Fetch orders in the window (status=any to include refunded). Paginated via Link header.
  const fields = 'id,name,created_at,financial_status,fulfillment_status,tags,customer,email,user_id,source_name,note_attributes,cancelled_at,line_items,subtotal_price,total_price,total_discounts,total_tax,refunds';
  let url = 'https://' + shop + '/admin/api/2026-04/orders.json?' +
    new URLSearchParams({
      status: 'any',
      limit: '250',
      fields: fields,
      created_at_min: windowStart.toISOString()
    }).toString();
  const orders = [];
  let pageCount = 0;
  const MAX_PAGES = 20; // safety — 250 × 20 = 5000 orders max per sync
  while (url && pageCount < MAX_PAGES) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      const t = await res.text().catch(function() { return ''; });
      throw new Error('Shopify pool fetch ' + res.status + ': ' + t.substring(0, 200));
    }
    const data = await res.json();
    if (Array.isArray(data.orders)) for (const o of data.orders) orders.push(o);
    const linkHdr = res.headers.get('link') || res.headers.get('Link') || '';
    const nextMatch = linkHdr.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    pageCount++;
  }

  // Build per-order cache (only pool-tagged orders matter for this cache)
  let cached = 0;
  for (const order of orders) {
    if (!order || !order.id) continue;
    if (order.cancelled_at) continue; // skip cancelled
    const tags = (typeof order.tags === 'string') ? order.tags.split(',').map(function(t) { return t.trim(); }) : [];
    const isPool = hasPoolTag(tags);
    if (!isPool) continue;
    // Payment gate: pool sales must be paid (per existing logic)
    const payOk = (order.financial_status === 'paid' || order.financial_status === 'authorized');
    if (!payOk) continue;

    const rep = identifyRepFor(order, null); // staffById TBD — Phase 1B
    const net = netSalesFor(order);
    const customerOrderCount = (order.customer && order.customer.orders_count) || 1;
    const isReturning = customerOrderCount > 1;

    const entry = {
      order_id: String(order.id),
      order_name: order.name || '',
      sale_date: order.created_at,
      rep: rep || null,
      pool_flag: true,
      total_net: net,
      total_gross: parseFloat(order.subtotal_price) || 0,
      customer_type: isReturning ? 'returning' : 'new',
      financial_status: order.financial_status,
      line_items: Array.isArray(order.line_items) ? order.line_items.map(function(li) {
        return {
          title: li.title || '',
          sku: li.sku || '',
          quantity: parseInt(li.quantity) || 0,
          price: parseFloat(li.price) || 0,
          vendor: li.vendor || ''
        };
      }) : [],
      cached_at: Date.now()
    };

    await writeFirebase('ops_data/salesInsights/orders/' + entry.order_id, entry);
    cached++;
  }

  // After caching, recompute aggregations for the window
  await recomputeSalesAggregates(windowStart);

  return { ordersCached: cached, ordersFetched: orders.length, pages: pageCount };
}

// Aggregates per-rep totals + quarterly progress from cached orders.
// Reads ops_data/salesInsights/orders/* in window, computes rollups.
async function recomputeSalesAggregates(windowStart) {
  // Read all cached orders
  const allOrders = await readFirebase('ops_data/salesInsights/orders') || {};
  // Read hours data (Phase 1A.2 will populate; for now may be empty)
  const allHours = await readFirebase('ops_data/salesInsights/hours') || {};

  // Group orders by day + by rep
  const dayPool = {};        // dayKey → total_pool_net
  const dayRepHours = {};    // dayKey → { rep: hours }
  const repPersonal = {};    // rep → { net, gross, returning, new }
  const repPoolShareByDay = {}; // dayKey → { rep: shareDollars }
  const quarterlyByRep = {}; // rep → { quarterKey: netTotal }

  // Init tracked reps
  for (const rep of TRACKED_REPS) {
    repPersonal[rep] = { net: 0, gross: 0, returning_net: 0, new_net: 0 };
  }

  // Pre-build hours lookup
  for (const repName of Object.keys(allHours)) {
    const repDays = allHours[repName] || {};
    for (const dayKey of Object.keys(repDays)) {
      if (!dayRepHours[dayKey]) dayRepHours[dayKey] = {};
      dayRepHours[dayKey][repName] = parseFloat(repDays[dayKey].hours_worked) || 0;
    }
  }

  // Iterate all cached orders
  for (const orderId of Object.keys(allOrders)) {
    const ord = allOrders[orderId];
    if (!ord) continue;
    const dayKey = dayKeyFor(ord.sale_date);
    const qKey = quarterKeyFor(ord.sale_date);

    // Pool sales aggregate by day
    if (ord.pool_flag) {
      dayPool[dayKey] = (dayPool[dayKey] || 0) + (ord.total_net || 0);
    } else if (ord.rep && TRACKED_REPS.indexOf(ord.rep) > -1) {
      // Individual sale credited to rep
      repPersonal[ord.rep].net += (ord.total_net || 0);
      repPersonal[ord.rep].gross += (ord.total_gross || 0);
      if (ord.customer_type === 'returning') repPersonal[ord.rep].returning_net += (ord.total_net || 0);
      else repPersonal[ord.rep].new_net += (ord.total_net || 0);
      if (!quarterlyByRep[ord.rep]) quarterlyByRep[ord.rep] = {};
      quarterlyByRep[ord.rep][qKey] = (quarterlyByRep[ord.rep][qKey] || 0) + (ord.total_net || 0);
    }
  }

  // Distribute each day's pool to reps by hours
  for (const dayKey of Object.keys(dayPool)) {
    const poolAmt = dayPool[dayKey];
    const hoursByRep = dayRepHours[dayKey] || {};
    // Sum only TRACKED_REPS hours (management excluded per policy)
    let totalRepHours = 0;
    for (const rep of TRACKED_REPS) {
      totalRepHours += (hoursByRep[rep] || 0);
    }
    if (totalRepHours <= 0) continue; // zero division guard — no rep worked, pool unattributed for this day
    for (const rep of TRACKED_REPS) {
      const repHrs = hoursByRep[rep] || 0;
      if (repHrs <= 0) continue;
      const shareCredit = poolAmt * (repHrs / totalRepHours);
      if (!repPoolShareByDay[dayKey]) repPoolShareByDay[dayKey] = {};
      repPoolShareByDay[dayKey][rep] = shareCredit;
      // Add to quarterly threshold counter
      const qKey = quarterKeyFor(dayKey);
      if (!quarterlyByRep[rep]) quarterlyByRep[rep] = {};
      quarterlyByRep[rep][qKey] = (quarterlyByRep[rep][qKey] || 0) + shareCredit;
    }
  }

  // Write per-rep aggregates
  const periodId = 'last14d_' + dayKeyFor(windowStart);
  for (const rep of TRACKED_REPS) {
    const p = repPersonal[rep];
    // Sum pool shares across all days in window
    let poolShareTotal = 0;
    let hoursTotal = 0;
    for (const dayKey of Object.keys(repPoolShareByDay)) {
      poolShareTotal += (repPoolShareByDay[dayKey][rep] || 0);
    }
    for (const dayKey of Object.keys(dayRepHours)) {
      hoursTotal += (dayRepHours[dayKey][rep] || 0);
    }
    await writeFirebase('ops_data/salesInsights/repTotals/' + rep + '/' + periodId, {
      rep: rep,
      period_id: periodId,
      period_start: dayKeyFor(windowStart),
      personal_net: p.net,
      personal_gross: p.gross,
      personal_returning_net: p.returning_net,
      personal_new_net: p.new_net,
      pool_share_net: poolShareTotal,
      total_hours: hoursTotal,
      computed_at: Date.now()
    });
  }

  // Write quarterly threshold progress
  for (const rep of TRACKED_REPS) {
    const quarters = quarterlyByRep[rep] || {};
    for (const qKey of Object.keys(quarters)) {
      const netTotal = quarters[qKey];
      const threshold = 250000;
      await writeFirebase('ops_data/salesInsights/quarterly/' + rep + '/' + qKey, {
        rep: rep,
        quarter_id: qKey,
        personal_net_sales: netTotal,
        threshold_target: threshold,
        threshold_met: netTotal >= threshold,
        rate_current: 4,
        rate_for_next_quarter: netTotal >= threshold ? 4 : 3,
        computed_at: Date.now()
      });
    }
  }
}
