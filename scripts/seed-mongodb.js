require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('ERROR: MONGO_URI environment variable is required to run the seed script.');
  console.error('Please configure MONGO_URI in your .env file or environment.');
  process.exit(1);
}

const HANDSETS = [
  {
    id: 'galaxy-s26-ultra',
    brand: 'Samsung',
    name: 'Galaxy S26 Ultra',
    storage: '512GB',
    colour: 'Black',
    colourHex: '#292a2c',
    price: 2399,
    rrp: 2499,
    discountAmount: 100,
    label: 'The flagship',
    image: '/brand/images/galaxy-s26-ultra-512gb-black.jpg',
    heroCutout: '/brand/images/galaxy-s26-ultra-hero-cutout.png',
    description: 'A big screen. A brilliant camera. Your next big idea.',
    specs: ['6.9-inch display', '200MP main camera', '5G + eSIM'],
    active: true,
    displayOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    id: 'galaxy-s26',
    brand: 'Samsung',
    name: 'Galaxy S26',
    storage: '256GB',
    colour: 'Black',
    colourHex: '#292a2c',
    price: 1499,
    rrp: 1549,
    discountAmount: 50,
    label: 'Everyday premium',
    image: '/brand/images/galaxy-s26-256gb-black.jpg',
    description: 'All the good stuff, in a beautifully pocket-sized phone.',
    specs: ['6.3-inch display', '50MP main camera', '5G + eSIM'],
    active: true,
    displayOrder: 2,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    id: 'pixel-11-pro',
    brand: 'Google',
    name: 'Pixel 11 Pro',
    storage: '256GB',
    colour: 'Obsidian',
    colourHex: '#363737',
    price: 1799,
    rrp: 1849,
    discountAmount: 50,
    label: 'Google, upgraded',
    image: '/brand/images/pixel-11-pro-256gb-obsidian.jpg',
    description: 'A thoughtful Android experience, with a pro-level camera.',
    specs: ['6.3-inch OLED', '50MP main camera', '5G + eSIM'],
    active: true,
    displayOrder: 3,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    id: 'galaxy-a56',
    brand: 'Samsung',
    name: 'Galaxy A56',
    storage: '128GB',
    colour: 'Awesome Graphite',
    colourHex: '#656869',
    price: 679,
    rrp: 699,
    discountAmount: 20,
    label: 'Everyday value',
    image: '/brand/images/galaxy-a56-128gb-enterprise-graphite.jpg',
    description: 'A generous screen and the essentials, without the big spend.',
    specs: ['6.7-inch AMOLED', '50MP main camera', '5G + eSIM'],
    note: 'Enterprise Edition',
    active: true,
    displayOrder: 4,
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

const PLANS = [
  {
    id: 'plan-20gb',
    name: 'Just enough',
    tier: '20GB',
    dataGb: 20,
    pricePerMonth: 19,
    description: 'For the everyday essentials.',
    popular: false,
    badgeText: 'SIM-only',
    features: [
      'Unlimited standard AU calls & texts',
      'Telstra Wholesale Network',
      'eSIM on compatible devices',
      'Proposed month-to-month service'
    ],
    dataBankingMaxGb: 200,
    active: true,
    displayOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    id: 'plan-50gb',
    name: 'Just right',
    tier: '50GB',
    dataGb: 50,
    pricePerMonth: 25,
    description: 'A little more room for life.',
    popular: true,
    badgeText: 'Our sweet spot ↗',
    features: [
      'Unlimited standard AU calls & texts',
      'Telstra Wholesale Network',
      'eSIM on compatible devices',
      'Proposed month-to-month service'
    ],
    dataBankingMaxGb: 500,
    active: true,
    displayOrder: 2,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    id: 'plan-100gb',
    name: 'Just more',
    tier: '100GB',
    dataGb: 100,
    pricePerMonth: 35,
    description: 'For life in full stream.',
    popular: false,
    badgeText: 'SIM-only',
    features: [
      'Unlimited standard AU calls & texts',
      'Telstra Wholesale Network',
      'eSIM on compatible devices',
      'Proposed month-to-month service'
    ],
    dataBankingMaxGb: 1000,
    active: true,
    displayOrder: 3,
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

const FAQS = [
  {
    id: 'faq-1',
    q: 'Can I bring my own phone and keep my number?',
    question: 'Can I bring my own phone and keep my number?',
    a: "That's the proposed experience. You'll need an unlocked phone compatible with the network and eSIM. Keep your current service active until your number transfer completes. Matching account details, identity checks and transfer eligibility will apply.",
    answer: "That's the proposed experience. You'll need an unlocked phone compatible with the network and eSIM. Keep your current service active until your number transfer completes. Matching account details, identity checks and transfer eligibility will apply.",
    displayOrder: 1,
    active: true
  },
  {
    id: 'faq-2',
    q: 'How can I pay for a new phone?',
    question: 'How can I pay for a new phone?',
    a: 'Explore outright purchase, handset instalments, or a phone plus mobile plan. The calculator illustrates 12, 24 and 36-month terms with an optional upfront contribution. Instalments assume no added financing cost, but a finance provider, fees, eligibility and commercial terms have not been approved. No credit application is submitted in this preview.',
    answer: 'Explore outright purchase, handset instalments, or a phone plus mobile plan. The calculator illustrates 12, 24 and 36-month terms with an optional upfront contribution. Instalments assume no added financing cost, but a finance provider, fees, eligibility and commercial terms have not been approved. No credit application is submitted in this preview.',
    displayOrder: 2,
    active: true
  },
  {
    id: 'faq-3',
    q: 'Is a month-to-month plan the same as a phone repayment term?',
    question: 'Is a month-to-month plan the same as a phone repayment term?',
    a: "No. Your mobile service and handset payments are separate. A proposed month-to-month service doesn't mean the phone is free to cancel. Any outstanding handset balance may be payable when you leave. Final ownership and early-exit terms must be approved before launch.",
    answer: "No. Your mobile service and handset payments are separate. A proposed month-to-month service doesn't mean the phone is free to cancel. Any outstanding handset balance may be payable when you leave. Final ownership and early-exit terms must be approved before launch.",
    displayOrder: 3,
    active: true
  },
  {
    id: 'faq-4',
    q: 'Which network would JustMobile use?',
    question: 'Which network would JustMobile use?',
    a: "The proposed service uses the Telstra Wholesale Mobile Network. This differs from Telstra's retail network. Check the official predicted outdoor coverage map for your address; coverage and performance vary by location, compatible device and conditions. 5G access also requires an eligible plan.",
    answer: "The proposed service uses the Telstra Wholesale Mobile Network. This differs from Telstra's retail network. Check the official predicted outdoor coverage map for your address; coverage and performance vary by location, compatible device and conditions. 5G access also requires an eligible plan.",
    displayOrder: 4,
    active: true
  },
  {
    id: 'faq-5',
    q: 'Are these handset prices and stock live?',
    question: 'Are these handset prices and stock live?',
    a: 'No. These are indicative customer prices including GST, proposed slightly below supplier-listed RRP. Models and selected configurations were available in the supplier catalogue at review on 27 October 2026. Stock is not live and must be reconfirmed. Prices may not be lower than retailer promotions.',
    answer: 'No. These are indicative customer prices including GST, proposed slightly below supplier-listed RRP. Models and selected configurations were available in the supplier catalogue at review on 27 October 2026. Stock is not live and must be reconfirmed. Prices may not be lower than retailer promotions.',
    displayOrder: 5,
    active: true
  },
  {
    id: 'faq-6',
    q: 'What is eSIM, and will it work on my phone?',
    question: 'What is eSIM, and will it work on my phone?',
    a: 'An eSIM is a digital SIM installed on a compatible phone instead of a removable plastic SIM. Compatibility depends on the exact device model, market variant and network configuration. The showcased supplier models list eSIM support; your own device will need to be checked before activation.',
    answer: 'An eSIM is a digital SIM installed on a compatible phone instead of a removable plastic SIM. Compatibility depends on the exact device model, market variant and network configuration. The showcased supplier models list eSIM support; your own device will need to be checked before activation.',
    displayOrder: 6,
    active: true
  },
  {
    id: 'faq-7',
    q: 'Can I sign up or order today?',
    question: 'Can I sign up or order today?',
    a: "Not in this preview. You can explore plans, configure phone payment estimates and try Bele's scripted demo. Checkout, finance, number transfers, email subscriptions, account login and live support are not connected. Approved pricing, terms and Critical Information Summaries are required before launch.",
    answer: "Not in this preview. You can explore plans, configure phone payment estimates and try Bele's scripted demo. Checkout, finance, number transfers, email subscriptions, account login and live support are not connected. Approved pricing, terms and Critical Information Summaries are required before launch.",
    displayOrder: 7,
    active: true
  }
];

async function seed() {
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log('✓ Connected successfully to MongoDB server.');

    const db = client.db('just_mobile_development');

    // 1. Handsets Collection
    const handsetsCol = db.collection('handsets');
    await handsetsCol.createIndex({ id: 1 }, { unique: true });
    for (const h of HANDSETS) {
      await handsetsCol.updateOne(
        { id: h.id },
        { $set: h },
        { upsert: true }
      );
    }
    console.log(`✓ Seeded ${HANDSETS.length} handsets into 'handsets' collection.`);

    // 2. Plans Collection
    const plansCol = db.collection('plans');
    await plansCol.createIndex({ id: 1 }, { unique: true });
    for (const p of PLANS) {
      await plansCol.updateOne(
        { id: p.id },
        { $set: p },
        { upsert: true }
      );
    }
    console.log(`✓ Seeded ${PLANS.length} plans into 'plans' collection.`);

    // 3. FAQs Collection
    const faqsCol = db.collection('faqs');
    await faqsCol.createIndex({ id: 1 }, { unique: true });
    for (const f of FAQS) {
      await faqsCol.updateOne(
        { id: f.id },
        { $set: f },
        { upsert: true }
      );
    }
    console.log(`✓ Seeded ${FAQS.length} FAQs into 'faqs' collection.`);

    // Check counts
    const countH = await handsetsCol.countDocuments();
    const countP = await plansCol.countDocuments();
    const countF = await faqsCol.countDocuments();

    console.log('\n--- MongoDB Collection Summary ---');
    console.log(`Database: just_mobile_development`);
    console.log(`Collection 'handsets': ${countH} documents`);
    console.log(`Collection 'plans':    ${countP} documents`);
    console.log(`Collection 'faqs':     ${countF} documents`);
    console.log('----------------------------------');

  } catch (err) {
    console.error('MongoDB Seeding failed:', err);
    process.exit(1);
  } finally {
    await client.close();
    console.log('MongoDB connection closed.');
  }
}

seed();
