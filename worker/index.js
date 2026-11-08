
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers });

const base = env => {
  if (env.PAYPAL_MODE !== "sandbox") {
    throw new Error("Only PayPal Sandbox is permitted");
  }
  return "https://api-m.sandbox.paypal.com";
};

const cents = value => {
  if (
    typeof value !== "string" ||
    !/^\d+(\.\d{1,2})?$/.test(value)
  ) {
    throw new Error("Invalid monetary amount");
  }

  const [whole, fraction = ""] = value.split(".");
  const amount =
    Number(whole) * 100 +
    Number(fraction.padEnd(2, "0"));

  if (!Number.isSafeInteger(amount)) {
    throw new Error("Amount outside safe range");
  }

  return amount;
};

const dollars = amount =>
  `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;

async function token(env) {
  const auth = btoa(
    `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`
  );

  const response = await fetch(
    `${base(env)}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }
  );

  if (!response.ok) {
    throw new Error("PayPal authentication failed");
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error("PayPal access token missing");
  }

  return data.access_token;
}

async function pp(env, path, options = {}) {
  const accessToken = await token(env);

  const response = await fetch(`${base(env)}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`PayPal request failed: ${response.status}`);
  }

  return response.json();
}

async function verifiedOrder(env, orderId) {
  if (!env.PAYPAL_MERCHANT_ID) {
    throw new Error("Merchant ID missing");
  }

  const order = await pp(
    env,
    `/v2/checkout/orders/${encodeURIComponent(orderId)}`
  );

  if (
    order.id !== orderId ||
    order.purchase_units?.length !== 1 ||
    order.purchase_units[0].payee?.merchant_id !==
      env.PAYPAL_MERCHANT_ID
  ) {
    throw new Error("Order or merchant mismatch");
  }

  return order;
}

async function verifiedCapture(env, captureId, orderId, saved) {
  const order = await verifiedOrder(env, orderId);

  const capture = await pp(
    env,
    `/v2/payments/captures/${encodeURIComponent(captureId)}`
  );

  const captures =
    order.purchase_units[0].payments?.captures || [];

  const linked = captures.some(c => c.id === captureId);

  if (
    !linked ||
    capture.id !== captureId ||
    capture.supplementary_data?.related_ids?.order_id !== orderId ||
    capture.payee?.merchant_id !== env.PAYPAL_MERCHANT_ID ||
    capture.amount?.currency_code !== saved.currency ||
    cents(capture.amount?.value) !== cents(saved.expected_amount)
  ) {
    throw new Error("Capture verification failed");
  }

  return capture;
}

async function updateRefundTotals(env, captureId) {
  const contribution = await env.DB.prepare(
    "SELECT * FROM contributions WHERE capture_id=?"
  ).bind(captureId).first();

  if (!contribution || contribution.status === "REVERSED") {
    return;
  }

  const result = await env.DB.prepare(
    "SELECT amount,currency FROM paypal_refunds WHERE capture_id=?"
  ).bind(captureId).all();

  let refunded = 0;

  for (const refund of result.results || []) {
    if (refund.currency !== contribution.currency) {
      throw new Error("Refund currency mismatch");
    }

    refunded += cents(refund.amount);
  }

  const original = cents(contribution.amount);

  if (refunded > original) {
    throw new Error("Refund exceeds original contribution");
  }

  const status =
    refunded === 0
      ? "COMPLETED"
      : refunded === original
        ? "REFUNDED"
        : "PARTIALLY_REFUNDED";

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE contributions SET refunded_amount=?,status=? WHERE capture_id=? AND status!='REVERSED'"
    ).bind(dollars(refunded), status, captureId),

    env.DB.prepare(
      "UPDATE paypal_orders SET status=? WHERE capture_id=? AND status!='REVERSED'"
    ).bind(status, captureId)
  ]);
}

async function markReversed(env, captureId) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE contributions SET status='REVERSED' WHERE capture_id=?"
    ).bind(captureId),

    env.DB.prepare(
      "UPDATE paypal_orders SET status='REVERSED' WHERE capture_id=?"
    ).bind(captureId)
  ]);
}

async function recordCapture(env, orderId, captureId) {
  const saved = await env.DB.prepare(
    "SELECT * FROM paypal_orders WHERE order_id=?"
  ).bind(orderId).first();

  if (!saved) {
    throw new Error("Unknown local order");
  }

  if (saved.capture_id && saved.capture_id !== captureId) {
    throw new Error("Order capture mismatch");
  }

  const capture = await verifiedCapture(
    env,
    captureId,
    orderId,
    saved
  );

  if (
    ![
      "COMPLETED",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
      "REVERSED"
    ].includes(capture.status)
  ) {
    return { status: capture.status || "PENDING" };
  }

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE paypal_orders SET capture_id=COALESCE(capture_id,?),captured_at=COALESCE(captured_at,CURRENT_TIMESTAMP),status=CASE WHEN status IN ('REFUNDED','REVERSED','PARTIALLY_REFUNDED') THEN status ELSE 'COMPLETED' END WHERE order_id=? AND (capture_id IS NULL OR capture_id=?)"
    ).bind(captureId, orderId, captureId),

    env.DB.prepare(
      "INSERT OR IGNORE INTO contributions (capture_id,amount,currency,status,refunded_amount) VALUES (?,?,?,'COMPLETED','0.00')"
    ).bind(captureId, saved.expected_amount, saved.currency)
  ]);

  await updateRefundTotals(env, captureId);

  if (capture.status === "REVERSED") {
    await markReversed(env, captureId);
  }

  return { status: capture.status };
}

async function createOrder(request, env) {
  base(env);

  const body = await request.json().catch(() => ({}));
  const raw = String(body.amount ?? "");

  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) {
    return reply({ error: "Invalid contribution amount" }, 400);
  }

  const amountCents = cents(raw);

  if (amountCents < 100 || amountCents > 50000) {
    return reply(
      { error: "Amount must be USD 1.00–500.00" },
      400
    );
  }

  const amount = dollars(amountCents);

  const order = await pp(env, "/v2/checkout/orders", {
    method: "POST",
    headers: {
      "paypal-request-id": crypto.randomUUID()
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount: {
          currency_code: "USD",
          value: amount
        },
        description:
          "Voluntary contribution to The Internet's Tip Jar"
      }]
    })
  });

  await env.DB.prepare(
    "INSERT INTO paypal_orders (order_id,expected_amount,currency,status) VALUES (?,?,'USD','CREATED')"
  ).bind(order.id, amount).run();

  return reply({ id: order.id });
}

async function captureOrder(id, env) {
  base(env);

  const saved = await env.DB.prepare(
    "SELECT * FROM paypal_orders WHERE order_id=?"
  ).bind(id).first();

  if (!saved) {
    return reply({ error: "Unknown order" }, 404);
  }

  if (
    [
      "COMPLETED",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
      "REVERSED"
    ].includes(saved.status)
  ) {
    return reply({ status: saved.status });
  }

  const order = await pp(
    env,
    `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
    {
      method: "POST",
      headers: {
        "paypal-request-id": `tipjar-${id}`.slice(0, 108)
      },
      body: "{}"
    }
  );

  if (
    order.id !== id ||
    order.purchase_units?.length !== 1 ||
    order.purchase_units[0].payee?.merchant_id !==
      env.PAYPAL_MERCHANT_ID
  ) {
    return reply({ error: "Order or merchant mismatch" }, 409);
  }

  const capture =
    order.purchase_units[0].payments?.captures?.[0];

  if (!capture?.id) {
    return reply(
      { status: order.status || "PENDING" },
      202
    );
  }

  const result = await recordCapture(env, id, capture.id);

  return reply(
    result,
    result.status === "COMPLETED" ? 200 : 202
  );
}

async function processRefund(env, event) {
  const refundId = event.resource?.id;

  if (!refundId) {
    throw new Error("Refund ID missing");
  }

  const refund = await pp(
    env,
    `/v2/payments/refunds/${encodeURIComponent(refundId)}`
  );

  if (
    refund.id !== refundId ||
    refund.status !== "COMPLETED"
  ) {
    throw new Error("Refund not confirmed");
  }

  const captureId =
    refund.supplementary_data?.related_ids?.capture_id ||
    event.resource?.supplementary_data?.related_ids?.capture_id;

  if (!captureId) {
    throw new Error("Refund capture linkage requires investigation");
  }

  const local = await env.DB.prepare(
    "SELECT order_id,expected_amount,currency FROM paypal_orders WHERE capture_id=?"
  ).bind(captureId).first();

  if (!local) {
    throw new Error("Original capture not found locally");
  }

  await verifiedCapture(
    env,
    captureId,
    local.order_id,
    local
  );

  if (
    refund.amount?.currency_code !== local.currency ||
    cents(refund.amount?.value) <= 0
  ) {
    throw new Error("Refund amount mismatch");
  }

  await env.DB.prepare(
    "INSERT OR IGNORE INTO paypal_refunds (refund_id,capture_id,amount,currency) VALUES (?,?,?,?)"
  ).bind(
    refundId,
    captureId,
    dollars(cents(refund.amount.value)),
    local.currency
  ).run();

  await updateRefundTotals(env, captureId);
}

async function processReversal(env, event) {
  const captureId = event.resource?.id;

  if (!captureId) {
    throw new Error("Reversal capture ID missing");
  }

  const local = await env.DB.prepare(
    "SELECT order_id,expected_amount,currency FROM paypal_orders WHERE capture_id=?"
  ).bind(captureId).first();

  if (!local) {
    throw new Error("Unknown reversed capture");
  }

  const capture = await verifiedCapture(
    env,
    captureId,
    local.order_id,
    local
  );

  if (capture.status !== "REVERSED") {
    throw new Error("Reversal not yet confirmed");
  }

  await markReversed(env, captureId);
}

async function webhook(request, event, env) {
  base(env);

  if (!env.PAYPAL_WEBHOOK_ID) {
    throw new Error("Webhook ID missing");
  }

  const h = request.headers;

  const verification = await pp(
    env,
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      body: JSON.stringify({
        auth_algo: h.get("paypal-auth-algo"),
        cert_url: h.get("paypal-cert-url"),
        transmission_id: h.get("paypal-transmission-id"),
        transmission_sig: h.get("paypal-transmission-sig"),
        transmission_time: h.get("paypal-transmission-time"),
        webhook_id: env.PAYPAL_WEBHOOK_ID,
        webhook_event: event
      })
    }
  );

  if (verification.verification_status !== "SUCCESS") {
    return reply({ error: "Invalid webhook signature" }, 400);
  }

  if (!event?.id || !event?.event_type) {
    return reply({ error: "Malformed webhook" }, 400);
  }

  const processed = await env.DB.prepare(
    "SELECT event_id FROM processed_webhooks WHERE event_id=?"
  ).bind(event.id).first();

  if (processed) {
    return reply({ received: true, duplicate: true });
  }

  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED": {
      const captureId = event.resource?.id;
      const orderId =
        event.resource?.supplementary_data?.related_ids?.order_id;

      if (!captureId || !orderId) {
        throw new Error("Capture or order ID missing");
      }

      const result = await recordCapture(
        env,
        orderId,
        captureId
      );

      if (
        ![
          "COMPLETED",
          "PARTIALLY_REFUNDED",
          "REFUNDED",
          "REVERSED"
        ].includes(result.status)
      ) {
        throw new Error("Capture not yet completed");
      }

      break;
    }

    case "PAYMENT.CAPTURE.REFUNDED":
      await processRefund(env, event);
      break;

    case "PAYMENT.CAPTURE.REVERSED":
      await processReversal(env, event);
      break;

    case "PAYMENT.CAPTURE.DECLINED": {
      const captureId = event.resource?.id;
      const orderId =
        event.resource?.supplementary_data?.related_ids?.order_id;

      if (!captureId || !orderId) {
        throw new Error("Declined capture identifiers missing");
      }

      const saved = await env.DB.prepare(
        "SELECT * FROM paypal_orders WHERE order_id=?"
      ).bind(orderId).first();

      if (!saved) {
        throw new Error("Unknown declined order");
      }

      const capture = await verifiedCapture(
        env,
        captureId,
        orderId,
        saved
      );

      if (capture.status !== "DECLINED") {
        throw new Error("Decline not confirmed");
      }

      await env.DB.prepare(
        "UPDATE paypal_orders SET status='DECLINED' WHERE order_id=? AND status='CREATED'"
      ).bind(orderId).run();

      break;
    }

    default:
      return reply({ received: true, ignored: true });
  }

  await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_webhooks (event_id,event_type) VALUES (?,?)"
  ).bind(event.id, event.event_type).run();

  return reply({ received: true });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (
        request.method === "POST" &&
        url.pathname === "/api/paypal/orders"
      ) {
        return createOrder(request, env);
      }

      const match = url.pathname.match(
        /^\/api\/paypal\/orders\/([A-Za-z0-9_-]+)\/capture$/
      );

      if (request.method === "POST" && match) {
        return captureOrder(match[1], env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/paypal/webhook"
      ) {
        return webhook(
          request,
          await request.json(),
          env
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/public/jar-progress"
      ) {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM contributions WHERE status IN ('COMPLETED','PARTIALLY_REFUNDED')"
        ).first();

        return reply({
          verifiedContributionCount: Number(row?.total || 0)
        });
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error(
        "Request failed",
        error?.message || "unknown"
      );

      return reply(
        {
          error:
            "Request failed. Check Worker configuration and logs."
        },
        500
      );
    }
  }
};
