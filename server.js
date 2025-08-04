const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const db = require('./firebaseAdmin');
const axios = require('axios');
const crypto = require('crypto');
const axiosRetry = require('axios-retry').default;
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));


// Setup axios retry: retries up to 3 times on network failures
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const razorpay = new Razorpay({
    key_id: process.env.key_id,
    key_secret: process.env.key_secret,
});

// ✅ Create Linked Account API
app.post('/create-linked-account', async (req, res) => {
    const { name, email, contact, producerId } = req.body;

    if (!name || !email || !contact || !producerId) {
        return res.status(400).send({ error: 'Missing required fields' });
    }

    try {
        const sanitizedPhone = contact.replace(/^\+91/, '').replace(/\D/g, '');
        console.log(`[${new Date().toISOString()}] Creating Razorpay account for ${name} with phone ${sanitizedPhone}`);

        // Step 1: Create Razorpay Linked Account
        const razorpayResponse = await axios.post(
            'https://api.razorpay.com/v2/accounts',
            {
                type: 'route',
                email,
                phone: sanitizedPhone,
                legal_business_name: name,
                business_type: 'individual',
                reference_id: `prod_${producerId.substring(0, 15)}`,
                contact_name: name,
                profile: {
                    category: 'others',
                    subcategory: 'others',
                    addresses: {
                        registered: {
                            street1: '90-f/A1',
                            street2: 'Mayur Vihar-3',
                            city: 'Delhi',
                            state: 'Delhi',
                            postal_code: 110096,
                            country: 'IN',
                        }
                    }
                }
            },
            {
                auth: {
                    username: process.env.key_id,
                    password: process.env.key_secret,
                },
                headers: { 'Content-Type': 'application/json' },
                timeout: 25000
            }
        );

        const account = razorpayResponse.data;
        console.log(`[${new Date().toISOString()}] Razorpay Linked Account created:`, account.id);

        // Step 2: Patch the account to ensure business_type etc. is properly set
        try {
            const patchResponse = await axios.patch(
                `https://api.razorpay.com/v2/accounts/${account.id}`,
                {
                    legal_business_name: name,
                    customer_facing_business_name: name,
                    contact_name: name
                },
                {
                    auth: {
                        username: process.env.key_id,
                        password: process.env.key_secret,
                    },
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 20000
                }
            );

            console.log(`[${new Date().toISOString()}] Razorpay Account patched with business_type 'individual':`, patchResponse.data);
        } catch (patchError) {
            console.error(`[${new Date().toISOString()}] Failed to patch Razorpay account for business_type:`, patchError?.response?.data || patchError.message);
            // Depending on your needs, you can choose to return error or proceed
        }

        // Step 3: Send response to client immediately
        res.status(200).json({ accountId: account.id });

        // Step 4: Update Firestore asynchronously
        db.collection('users').doc(producerId).update({
            linkedAccountId: account.id,
            kycCompleted: false
        }).then(() => {
            console.log(`[${new Date().toISOString()}] Firestore updated for producer ${producerId}`);
        }).catch(err => {
            console.error(`[${new Date().toISOString()}] Firestore update error:`, err);
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Razorpay Error:`, error?.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to create Razorpay account',
            details: error?.response?.data?.description || error.message
        });
    }
});
// server.js

// ... (existing imports like express, Razorpay, cors, db, axios, crypto, axiosRetry) ...

// IMPORTANT: Ensure express.raw() is used for the webhook ONLY if you're not using other body parsers before it.
// If you're using app.use(express.json()) globally, you might need to make sure the webhook path
// specifically uses raw body, e.g., by placing it before app.use(express.json()) or using a specific middleware.
// For simplicity, let's assume it's placed before app.use(express.json()) or handles raw body correctly.

// Add this new endpoint
// ✅ Generate Razorpay Hosted Onboarding Link for Linked Accounts
app.post('/generate-razorpay-onboarding-link', async (req, res) => {
    const { linkedAccountId } = req.body;

    if (!linkedAccountId) {
        return res.status(400).json({ error: 'Missing linkedAccountId for onboarding link generation.' });
    }

    try {
        console.log(`[${new Date().toISOString()}] Fetching Razorpay account details for ${linkedAccountId}...`);

        // Step 1: Get account details to validate
        const accountDetailsResponse = await axios.get(
            `https://api.razorpay.com/v2/accounts/${linkedAccountId}`,
            {
                auth: {
                    username: process.env.key_id,
                    password: process.env.key_secret,
                }
            }
        );

        const accountDetails = accountDetailsResponse.data;
        console.log(`[${new Date().toISOString()}] Account Details:`, accountDetails);

        if (accountDetails.type !== 'route') {
            return res.status(400).json({ error: 'Account is not of type route, onboarding link not applicable.' });
        }

        if (accountDetails.status !== 'created') {
            return res.status(400).json({ error: `Cannot generate onboarding link, account status is ${accountDetails.status}` });
        }

        // Step 2: Generate onboarding link with optional branding config
        console.log(`[${new Date().toISOString()}] Generating onboarding link for ${linkedAccountId}...`);

        const onboardingLinkResponse = await axios.post(
            `https://api.razorpay.com/v2/accounts/${linkedAccountId}/onboarding_link`,
            {
                color: "#528FF0",  // Optional: Button/UI color
                redirect_url: "https://yourapp.com/kyc-complete",  // Optional: where to redirect after completion
                logo: "https://yourapp.com/logo.png"  // Optional: Branding logo URL
            },
            {
                auth: {
                    username: process.env.key_id,
                    password: process.env.key_secret,
                },
                headers: { 'Content-Type': 'application/json' },
                timeout: 20000
            }
        );

        const onboardingLink = onboardingLinkResponse.data?.short_url;

        if (!onboardingLink) {
            console.error(`[${new Date().toISOString()}] Failed: onboarding link is empty/null`);
            return res.status(500).json({ error: 'Failed to fetch onboarding link from Razorpay.' });
        }

        console.log(`[${new Date().toISOString()}] Onboarding link generated: ${onboardingLink}`);
        return res.status(200).json({ onboardingLink });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error generating onboarding link:`, error?.response?.data || error.message);
        return res.status(500).json({
            error: 'Failed to generate Razorpay onboarding link',
            details: error?.response?.data?.description || error.message
        });
    }
});

// Add a Webhook endpoint (CRITICAL for updating KYC status in Firebase)
// Place this before app.use(express.json()) if you use express.json() globally,
// or use a separate Router for raw body parsing for webhooks.
app.post('/razorpay-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET; // Define this in your .env (e.g., RAZORPAY_WEBHOOK_SECRET=your_secret_string)

    // Verify webhook signature
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(req.body); // Use the raw body received from Razorpay
    const digest = shasum.digest('hex');

    if (digest === req.headers['x-razorpay-signature']) {
        const event = JSON.parse(req.body.toString()); // Parse the raw body to JSON after verification

        console.log(`[${new Date().toISOString()}] Razorpay Webhook received: Event Type - ${event.event}`);

        // Handle specific events
        if (event.event === 'account.activated' || event.event === 'account.updated') {
            const linkedAccountId = event.payload.account.entity.id;
            const accountStatus = event.payload.account.entity.status; // e.g., 'activated', 'under_review', 'created'
            const kycStatus = event.payload.account.entity.kyc_status; // e.g., 'verified', 'pending', 'rejected'

            console.log(`[${new Date().toISOString()}] Webhook Details: Account ID: ${linkedAccountId}, Status: ${accountStatus}, KYC Status: ${kycStatus}`);

            try {
                // Find the producer in your Firebase based on the linkedAccountId
                const usersRef = db.collection('users');
                const snapshot = await usersRef.where('linkedAccountId', '==', linkedAccountId).get();

                if (!snapshot.empty) {
                    const userDoc = snapshot.docs[0];
                    const updateData = {
                        razorpayAccountStatus: accountStatus,
                        razorpayKycStatus: kycStatus
                    };

                    // Only set kycCompleted to true if Razorpay confirms it's verified
                    if (kycStatus === 'verified') {
                        updateData.kycCompleted = true;
                    } else if (kycStatus === 'pending' || kycStatus === 'rejected') {
                         updateData.kycCompleted = false; // Ensure it's false if not verified
                    }


                    await userDoc.ref.update(updateData);
                    console.log(`[${new Date().toISOString()}] Firebase updated for producer ${userDoc.id} with Razorpay status.`);
                } else {
                    console.warn(`[${new Date().toISOString()}] Webhook: No producer found in Firebase for linkedAccountId: ${linkedAccountId}`);
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Webhook Firebase update error for ${linkedAccountId}:`, error);
            }
        }
        // You can add more event handlers here if needed for other Razorpay events

        res.status(200).send('Webhook Received');
    } else {
        console.warn(`[${new Date().toISOString()}] Invalid webhook signature received.`);
        res.status(403).send('Invalid Signature');
    }
});

// ... (your existing /create-linked-account, /complete-kyc, /transfer, etc. endpoints) ...
// ✅ Complete KYC API with enhanced logs
app.post('/complete-kyc', async (req, res) => {
    const { producerId, merchantId, accountNumber, ifscCode, beneficiaryName } = req.body;

    console.log(`[${new Date().toISOString()}] Incoming KYC Request:`, req.body);

    // Validate required fields
    if (!producerId || !merchantId || !accountNumber || !ifscCode || !beneficiaryName) {
        console.error(`[${new Date().toISOString()}] ❌ Missing fields in KYC submission:`, req.body);
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        console.log(`[${new Date().toISOString()}] Attempting Firestore update for producerId: ${producerId}`);

        await db.collection('users').doc(producerId).update({
            kycCompleted: true,
            linkedAccountId: merchantId,
            bankDetails: {
                accountNumber,
                ifscCode,
                beneficiaryName
            }
        });

        console.log(`[${new Date().toISOString()}] ✅ KYC details successfully updated for Producer: ${producerId}`);
        return res.status(200).json({ success: true, message: 'KYC completed and saved.' });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Failed to complete KYC for producer ${producerId}:`, error);
        return res.status(500).json({ error: "Failed to complete KYC", details: error.message });
    }
});

// ✅ Transfer Money to Linked Account
app.post('/transfer', async (req, res) => {
    const { producerId, amount, transactionId } = req.body;

    if (!producerId || !amount || !transactionId) {
        return res.status(400).send({ error: 'Missing fields in request' });
    }

    try {
        const userDoc = await db.collection('users').doc(producerId).get();

        if (!userDoc.exists) {
            return res.status(404).send({ error: 'Producer not found' });
        }

        const linkedAccountId = userDoc.data().linkedAccountId;
        if (!linkedAccountId) {
            return res.status(404).send({ error: 'Producer linked Razorpay account ID not found' });
        }

        const transferResponse = await razorpay.transfers.create({
            account: linkedAccountId,
            amount: amount * 100,  // paise
            currency: "INR",
            reference_id: transactionId,
            notes: {
                purpose: "Producer Payout"
            }
        });

        console.log(`[${new Date().toISOString()}] Transfer Successful:`, transferResponse);
        res.status(200).json({ success: true, transfer: transferResponse });

    } catch (error) {
        console.error('Transfer Error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Transfer failed', details: error.message });
    }
});

// ✅ Verify Payment Signature
app.post('/verify-payment', (req, res) => {
    const { orderId, paymentId, razorpaySignature } = req.body;

    if (!orderId || !paymentId || !razorpaySignature) {
        return res.status(400).json({ status: "failed", message: "Missing fields for verification." });
    }

    const generatedSignature = crypto.createHmac('sha256', process.env.KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

    if (generatedSignature !== razorpaySignature) {
        return res.status(400).json({ status: "failed", message: "Invalid signature" });
    }

    return res.status(200).json({ status: "success", message: "Payment verified successfully" });
});

// ✅ Create Razorpay Order
app.post('/initiate-payment', async (req, res) => {
    const { amount, currency = "INR", producerAccountId, consumerId, localOrderId, paymentMethod, upiId } = req.body;

    if (!amount || amount <= 0 || !producerAccountId || !consumerId || !localOrderId) {
        return res.status(400).json({ error: "Missing or invalid fields for order creation" });
    }

    try {
        const options = {
            amount: Math.round(amount * 100),
            currency,
            receipt: localOrderId,
            payment_capture: 1,
            notes: {
                producerAccountId,
                consumerId,
                paymentMethod,
                upiId: upiId || "",
            }
        };

        const order = await razorpay.orders.create(options);

        return res.status(200).json({
            orderId: order.id,
            amount: amount
        });

    } catch (error) {
        console.error("❌ Razorpay Order creation failed:", error.response?.data || error.message);
        return res.status(500).json({ error: "Failed to create Razorpay order", details: error.message });
    }
});
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>GreenBasket - Empowering Farmers</title>
        <style>
          body {
            font-family: 'Segoe UI', sans-serif;
            background-color: #f1f9f1;
            margin: 0;
            padding: 0;
          }
          .container {
            max-width: 1000px;
            margin: 40px auto;
            background-color: white;
            padding: 30px 50px;
            border-radius: 10px;
            box-shadow: 0 10px 20px rgba(0,0,0,0.1);
            text-align: center;
          }
          h1 {
            color: #2f7d32;
          }
          p {
            font-size: 18px;
            line-height: 1.6;
          }
          .image-grid {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 20px;
            margin-top: 30px;
          }
          .image-grid img {
            width: 30%;
            border-radius: 10px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
          }
          @media (max-width: 768px) {
            .image-grid img {
              width: 45%;
            }
          }
          @media (max-width: 480px) {
            .image-grid img {
              width: 90%;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Welcome to GreenBasket 🌱</h1>
          <p>This is the backend API service powering the GreenBasket mobile app — connecting local farmers with customers.</p>
          
          <h2>App Screens</h2>
          <div class="image-grid">
            <img src="/img1.jpg" />
            <img src="/img2.jpg" />
            <img src="/img3.jpg" />
            <img src="/img4.jpg" />
            <img src="/img5.jpg" />
            <img src="/img6.jpg" />
            <img src="/img66.jpg" />
            <img src="/img7.jpg" />
            <img src="/img8.jpg" />
            <img src="/img9.jpg" />
          </div>

          <p style="margin-top: 30px;"><strong>API is Live ✅</strong></p>
          <p>For more details, contact: <a href="mailto:jaissawhney123@gmail.com">jaissawhney123@gmail.com</a></p>
        </div>
      </body>
    </html>
  `);
});

// ✅ Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on PORT ${PORT}`);
});

