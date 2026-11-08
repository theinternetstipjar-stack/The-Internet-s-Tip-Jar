const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (data, status=200) => new Response(JSON.stringify(data), {status, headers});

const base = env => {
  if (env.PAYPAL_MODE !== "sandbox") {
    throw new Error("Only PayPal Sandbox is permitted during testing");
  }

  return "https://api-m.sandbox.paypal.com";
};

async function token(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error("PayPal credentials missing");
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const r = await fetch(`${base(env)}/v1/oauth2/token`, {
    method:"POST", headers:{authorization:`Basic ${auth}`, "content-type":"application/x-www-form-urlencoded"},
    body:"grant_type=client_credentials"
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error("PayPal authentication failed");
  return d.access_token;
}
async function pp(env, path, options={}) {
  const t = await token(env);
  const r = await fetch(`${base(env)}${path}`, {...options, headers:{
    authorization:`Bearer ${t}`, "content-type":"application/json", ...(options.headers||{})
  }});
  const d = await r.json();
  if (!r.ok) throw new Error("PayPal API request failed");
  return d;
}
async function createOrder(request, env) {
  const body = await request.json().catch(()=>({}));
  const raw = String(body.amount ?? "");
  const n = Number(raw);
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(raw) || !Number.isFinite(n) || n < 1 || n > 500)
    return reply({error:"Amount must be between USD 1.00 and USD 500.00."},400);
  const amount = n.toFixed(2);
  const order = await pp(env,"/v2/checkout/orders",{
    method:"POST", headers:{"paypal-request-id":crypto.randomUUID()},
    body:JSON.stringify({intent:"CAPTURE",purchase_units:[{amount:{currency_code:"USD",value:amount},
      description:"Voluntary contribution to The Internet's Tip Jar"}]})
  });
  await env.DB.prepare("INSERT INTO paypal_orders (order_id,expected_amount,currency,status) VALUES (?,?,'USD','CREATED')")
    .bind(order.id,amount).run();
  return reply({id:order.id});
}
async function captureOrder(id, env) {
  const saved = await env.DB.prepare("SELECT * FROM paypal_orders WHERE order_id=?").bind(id).first();
  if (!saved) return reply({error:"Unknown order"},404);
  if (saved.status==="COMPLETED") return reply({status:"COMPLETED"});
  const order = await pp(env,`/v2/checkout/orders/${encodeURIComponent(id)}/capture`,{method:"POST",body:"{}"});
  const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
  
if (!env.PAYPAL_MERCHANT_ID) {
  throw new Error("PayPal Merchant ID missing");
}

if (
  order.id !== id ||
  order.purchase_units?.length !== 1 ||
  order.purchase_units[0]?.payee?.merchant_id !==
    env.PAYPAL_MERCHANT_ID
) {
  return reply(
    { error: "PayPal order or merchant mismatch" },
    409
  );
}

  if (order.status!=="COMPLETED" || cap?.status!=="COMPLETED") return reply({status:order.status||"PENDING"},202);
  if (cap.amount?.currency_code!==saved.currency || Number(cap.amount?.value).toFixed(2)!==saved.expected_amount)
    return reply({error:"Captured amount mismatch"},409);
  await env.DB.batch([
    env.DB.prepare("UPDATE paypal_orders SET status='COMPLETED',capture_id=?,captured_at=CURRENT_TIMESTAMP WHERE order_id=?").bind(cap.id,id),
    env.DB.prepare("INSERT OR IGNORE INTO contributions (capture_id,amount,currency) VALUES (?,?,?)").bind(cap.id,saved.expected_amount,saved.currency)
  ]);
  return reply({status:"COMPLETED"});
}
async function webhook(request, event, env) {
  if (!env.PAYPAL_WEBHOOK_ID) throw new Error("Webhook ID missing");
  const h=request.headers;
  const verified=await pp(env,"/v1/notifications/verify-webhook-signature",{method:"POST",body:JSON.stringify({
    auth_algo:h.get("paypal-auth-algo"),cert_url:h.get("paypal-cert-url"),
    transmission_id:h.get("paypal-transmission-id"),transmission_sig:h.get("paypal-transmission-sig"),
    transmission_time:h.get("paypal-transmission-time"),webhook_id:env.PAYPAL_WEBHOOK_ID,webhook_event:event
  })});
  if (verified.verification_status!=="SUCCESS") return reply({error:"Webhook verification failed"},400);
  if (event.event_type==="PAYMENT.CAPTURE.COMPLETED") {
    const cap=event.resource, orderId=cap.supplementary_data?.related_ids?.order_id;
    if (cap.status==="COMPLETED" && orderId) {
      const saved=await env.DB.prepare("SELECT * FROM paypal_orders WHERE order_id=?").bind(orderId).first();
      if (saved && cap.amount?.currency_code===saved.currency && Number(cap.amount?.value).toFixed(2)===saved.expected_amount) {
        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO processed_webhooks (event_id,event_type) VALUES (?,?)").bind(event.id,event.event_type),
          env.DB.prepare("UPDATE paypal_orders SET status='COMPLETED',capture_id=?,captured_at=CURRENT_TIMESTAMP WHERE order_id=?").bind(cap.id,orderId),
          env.DB.prepare("INSERT OR IGNORE INTO contributions (capture_id,amount,currency) VALUES (?,?,?)").bind(cap.id,saved.expected_amount,saved.currency)
        ]);
      }
    }
  }
  return reply({received:true});
}
export default { async fetch(request,env) {
  try {
    const u=new URL(request.url);
    if(request.method==="POST" && u.pathname==="/api/paypal/orders") return createOrder(request,env);
    const m=u.pathname.match(/^\/api\/paypal\/orders\/([A-Za-z0-9_-]+)\/capture$/);
    if(request.method==="POST" && m) return captureOrder(m[1],env);
    if(request.method==="POST" && u.pathname==="/api/paypal/webhook") return webhook(request,await request.json(),env);
    if(request.method==="GET" && u.pathname==="/api/public/jar-progress") {
      const row=await env.DB.prepare("SELECT COUNT(*) AS total FROM contributions").first();
      return reply({verifiedContributionCount:Number(row?.total||0)});
    }
    return env.ASSETS.fetch(request);
  } catch(e) {
    console.error("Request failed",e?.message||"unknown");
    return reply({error:"Request failed. Check Worker configuration and logs."},500);
  }
}};
