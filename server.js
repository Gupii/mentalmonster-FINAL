require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());

// ==========================================
// 1. STRIPE WEBHOOK (MUST BE BEFORE express.json)
// ==========================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // Stripe checks the signature to ensure hackers aren't sending fake payments
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.whsec_labk33Gsfgs46IbAq9AVVo8WlbrZX07e
);
    } catch (err) {
        console.error('Webhook signature verification failed.', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // When the payment officially clears
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        try {
            // Ask Stripe for the specific items the customer bought
            const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
            
            // Helper function to format Stripe's cents into standard dollar strings ($40.00)
            const formatMoney = (cents) => `$${(cents / 100).toFixed(2)}`;
            
            // Build the HTML table rows for the purchased items
            let cartItemsHtml = '';
            lineItems.data.forEach(item => {
                cartItemsHtml += `
                <tr>
                    <td style="padding: 15px 0; border-bottom: 1px solid rgba(234, 221, 211, 0.1);">
                        <p style="margin: 0; font-size: 14px; font-weight: bold; color: #eaddd3;">${item.quantity}x ${item.description}</p>
                    </td>
                    <td align="right" style="padding: 15px 0; border-bottom: 1px solid rgba(234, 221, 211, 0.1); font-size: 14px; color: #eaddd3;">
                        ${formatMoney(item.amount_total)}
                    </td>
                </tr>`;
            });

            // Load your email-template.html file
            const templatePath = path.join(__dirname, 'email-template.html');
            let htmlTemplate = fs.readFileSync(templatePath, 'utf8');

            // Find and replace the {{target_brackets}} with the actual Stripe data
            const customerName = session.customer_details.name || 'Athlete';
            const subtotal = formatMoney(session.amount_subtotal);
            const total = formatMoney(session.amount_total);
            const shippingCost = formatMoney(session.total_details.amount_shipping);

            htmlTemplate = htmlTemplate
                .replace('{{customer_name}}', customerName)
                .replace('{{cart_items_html}}', cartItemsHtml)
                .replace('{{subtotal}}', subtotal)
                .replace('{{shipping_cost}}', shippingCost)
                .replace('{{total}}', total);

            // Fire the email via Resend
            const { data, error } = await resend.emails.send({
                from: 'Mental Monster <orders@mentalmonster.shop>',
                to: session.customer_details.email,
                subject: 'Order Confirmed - Mental Monster',
                html: htmlTemplate,
            });

            if (error) {
                console.error('Resend Error:', error);
            } else {
                console.log('Receipt sent successfully to:', session.customer_details.email);
            }
        } catch (err) {
            console.error('Error processing webhook event:', err);
        }
    }

    res.status(200).send('Webhook received.');
});


// ==========================================
// 2. STANDARD MIDDLEWARE & EXISTING ROUTES
// ==========================================
app.use(express.json());

const storeItems = new Map([
    ['Duality Sports Bra', { priceInCents: 4000 }]
]);

app.post('/create-checkout-session', async (req, res) => {
    try {
        const { cart } = req.body;

        // Generates a random 6-digit order ID (e.g., MM-482910)
        const orderId = 'MM-' + Math.floor(100000 + Math.random() * 900000);

        let cartTotalInCents = 0;

        const lineItems = cart.map(item => {
            const storeItem = storeItems.get(item.name);
            if (!storeItem) throw new Error(`Product ${item.name} not found.`);
            
            // Calculate cart total to determine shipping
            cartTotalInCents += storeItem.priceInCents * item.qty;

            return {
                price_data: {
                    currency: 'sgd',
                    product_data: {
                        name: item.name,
                        images: [item.img],
                        description: `Size: ${item.size} | Colour: ${item.color}`, 
                    },
                    unit_amount: storeItem.priceInCents,
                },
                quantity: item.qty,
            };
        });

        // If cart total is >= $120 (12000 cents), standard shipping is 0
        const standardShippingCost = cartTotalInCents >= 12000 ? 0 : 500;
        const standardShippingName = cartTotalInCents >= 12000 ? 'Free Standard Delivery (Orders over $120)' : 'Standard Delivery';

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: lineItems,
            
            // Turns on the promo code box on the Stripe checkout page
            allow_promotion_codes: true,
            
            client_reference_id: orderId, 
            
            payment_intent_data: {
                metadata: {
                    order_id: orderId,
                    order_summary: cart.map(item => `${item.qty}x ${item.name} (Size: ${item.size}, Colour: ${item.color})`).join(' | ')
                }
            },

            phone_number_collection: { enabled: true },
            shipping_address_collection: { allowed_countries: ['SG'] },
            
            // INJECTED: Mandatory custom field for Unit Number
            custom_fields: [
                {
                    key: 'unit_number',
                    label: {
                        type: 'custom',
                        custom: 'Unit Number (e.g., #04-123)'
                    },
                    type: 'text',
                    optional: false
                }
            ],

            shipping_options: [
                {
                    shipping_rate_data: {
                        type: 'fixed_amount',
                        fixed_amount: { amount: standardShippingCost, currency: 'sgd' },
                        display_name: standardShippingName,
                        delivery_estimate: { minimum: { unit: 'business_day', value: 3 }, maximum: { unit: 'business_day', value: 5 } }
                    },
                },
                {
                    shipping_rate_data: {
                        type: 'fixed_amount',
                        fixed_amount: { amount: 1500, currency: 'sgd' },
                        display_name: 'Next Day Express',
                        delivery_estimate: { minimum: { unit: 'business_day', value: 1 }, maximum: { unit: 'business_day', value: 1 } }
                    },
                },
            ],
            success_url: `https://mentalmonster.shop/success.html?order=${orderId}`, 
            cancel_url: 'https://mentalmonster.shop/index.html',
        });

        res.json({ url: session.url });
    } catch (e) {
        console.error("STRIPE ERROR:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(4242, () => console.log('Mental Monster Payment Server running on port 4242'));