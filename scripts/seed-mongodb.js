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
      'Flexible month-to-month service'
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
    a: "Yes, absolutely! You can bring any unlocked phone compatible with our network and keep your existing Australian mobile number. During checkout, simply select 'Keep my number', complete the SMS verification, and we'll manage the switch with your current provider seamlessly.",
    answer: "Yes, absolutely! You can bring any unlocked phone compatible with our network and keep your existing Australian mobile number. During checkout, simply select 'Keep my number', complete the SMS verification, and we'll manage the switch with your current provider seamlessly.",
    displayOrder: 1,
    active: true
  },
  {
    id: 'faq-2',
    q: 'How can I pay for a new phone?',
    question: 'How can I pay for a new phone?',
    a: 'You can purchase your phone outright or spread the cost across flexible 12, 24, or 36-month instalment terms. You can also customize an optional upfront payment (0%, 25%, or 50%) to suit your monthly budget, or bundle your device with a JustMobile SIM-only plan.',
    answer: 'You can purchase your phone outright or spread the cost across flexible 12, 24, or 36-month instalment terms. You can also customize an optional upfront payment (0%, 25%, or 50%) to suit your monthly budget, or bundle your device with a JustMobile SIM-only plan.',
    displayOrder: 2,
    active: true
  },
  {
    id: 'faq-3',
    q: 'Is a month-to-month plan the same as a phone repayment term?',
    question: 'Is a month-to-month plan the same as a phone repayment term?',
    a: 'No, your mobile service and handset repayments are kept clearly distinct. Our mobile plans are month-to-month with no lock-in contracts, giving you the freedom to switch plans whenever your needs change. If you choose a handset on instalments, your device payments simply continue on their set term.',
    answer: 'No, your mobile service and handset repayments are kept clearly distinct. Our mobile plans are month-to-month with no lock-in contracts, giving you the freedom to switch plans whenever your needs change. If you choose a handset on instalments, your device payments simply continue on their set term.',
    displayOrder: 3,
    active: true
  },
  {
    id: 'faq-4',
    q: 'Which network would JustMobile use?',
    question: 'Which network would JustMobile use?',
    a: "JustMobile mobile services are powered by the Telstra Wholesale Mobile Network, reaching 98.8% of the Australian population with robust 4G and 5G coverage spanning over 1.4 million square kilometres.",
    answer: "JustMobile mobile services are powered by the Telstra Wholesale Mobile Network, reaching 98.8% of the Australian population with robust 4G and 5G coverage spanning over 1.4 million square kilometres.",
    displayOrder: 4,
    active: true
  },
  {
    id: 'faq-5',
    q: 'Are these handset prices and stock live?',
    question: 'Are these handset prices and stock live?',
    a: 'Yes! All handsets featured in our catalogue are genuine Australian models backed by full local manufacturer warranties, with prompt dispatch and free express delivery across Australia.',
    answer: 'Yes! All handsets featured in our catalogue are genuine Australian models backed by full local manufacturer warranties, with prompt dispatch and free express delivery across Australia.',
    displayOrder: 5,
    active: true
  },
  {
    id: 'faq-6',
    q: 'What is eSIM, and will it work on my phone?',
    question: 'What is eSIM, and will it work on my phone?',
    a: 'An eSIM is a digital SIM built directly into your phone that allows you to activate mobile service without waiting for a physical plastic SIM. Compatible models include recent iPhone, Samsung Galaxy, and Google Pixel devices. You can scan your QR code and get connected in minutes.',
    answer: 'An eSIM is a digital SIM built directly into your phone that allows you to activate mobile service without waiting for a physical plastic SIM. Compatible models include recent iPhone, Samsung Galaxy, and Google Pixel devices. You can scan your QR code and get connected in minutes.',
    displayOrder: 6,
    active: true
  },
  {
    id: 'faq-7',
    q: 'Can I sign up or order today?',
    question: 'Can I sign up or order today?',
    a: 'Yes! You can order online right now. Choose your plan, select a phone or bring your own, and complete checkout. If you select eSIM, your digital activation QR code is delivered directly to your inbox so you can connect straight away.',
    answer: 'Yes! You can order online right now. Choose your plan, select a phone or bring your own, and complete checkout. If you select eSIM, your digital activation QR code is delivered directly to your inbox so you can connect straight away.',
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
