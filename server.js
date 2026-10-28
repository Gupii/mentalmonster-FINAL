require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 

const app = express();
app.use(cors());
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