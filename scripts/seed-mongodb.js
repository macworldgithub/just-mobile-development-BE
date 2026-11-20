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
    id: 'plan-15gb',
    planNo: 11144154,
    name: 'JM 15GB Auto',
    tier: '15GB',
    dataGb: 15,
    pricePerMonth: 31,
    description: 'Great everyday data for light browsing and socials.',
    fit: 'Casual Browsing',
    network: '4G',
    popular: false,
    badgeText: '4G · SIM-only',
    roamingInternationalMinutes: false,
    features: [
      '15GB high-speed 4G monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 4G Network coverage',
      'Zero bill shock · data stops when cap reached',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 1,
    updatedAt: new Date(),
  },
  {
    id: 'plan-45gb',
    planNo: 11144156,
    name: 'JM 45GB Auto',
    tier: '45GB',
    dataGb: 45,
    pricePerMonth: 36,
    description: 'Fast 5G everyday data with international calls included.',
    fit: 'Everyday 5G',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '45GB superfast 5G monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 2,
    updatedAt: new Date(),
  },
  {
    id: 'plan-65gb',
    planNo: 11144157,
    name: 'JM 65GB Auto',
    tier: '65GB',
    dataGb: 65,
    pricePerMonth: 40,
    description: 'Our sweet spot 5G plan with generous high-speed data.',
    fit: 'Streaming & Video',
    network: '5G',
    popular: true,
    badgeText: 'Our sweet spot ↗',
    roamingInternationalMinutes: true,
    features: [
      '65GB superfast 5G monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 3,
    updatedAt: new Date(),
  },
  {
    id: 'plan-100gb',
    planNo: 11144168,
    name: 'JM 100GB Auto',
    tier: '100GB',
    dataGb: 100,
    pricePerMonth: 48,
    description: 'For life in full stream, hot-spotting, and high-definition video.',
    fit: 'Power Users & Hotspot',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '100GB uncapped 5G maximum speed monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 4,
    updatedAt: new Date(),
  },
  {
    id: 'plan-120gb',
    planNo: 11144169,
    name: 'JM 120GB Auto',
    tier: '120GB',
    dataGb: 120,
    pricePerMonth: 57,
    description: 'High allowance 5G data for hot-spotting, work, and travel.',
    fit: 'Work from Anywhere',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '120GB uncapped 5G maximum speed monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 5,
    updatedAt: new Date(),
  },
  {
    id: 'plan-150gb',
    planNo: 11144170,
    name: 'JM 150GB Auto',
    tier: '150GB',
    dataGb: 150,
    pricePerMonth: 62,
    description: 'Pro data package for heavy downloads, gaming, and remote work.',
    fit: 'Heavy Media & Creators',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '150GB uncapped 5G maximum speed monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 6,
    updatedAt: new Date(),
  },
  {
    id: 'plan-180gb',
    planNo: 11156014,
    name: 'JM 180GB Auto',
    tier: '180GB',
    dataGb: 180,
    pricePerMonth: 67,
    description: 'Maximum power 5G data with total freedom to stream and share.',
    fit: 'Ultimate Freedom',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '180GB uncapped 5G maximum speed monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Priority Australian support queue',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 7,
    updatedAt: new Date(),
  },
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
    q: 'How can I purchase a new phone?',
    question: 'How can I purchase a new phone?',
    a: 'All handsets in our store are purchased outright as a simple, transparent e-commerce transaction. There are no complicated lock-in financing contracts or confusing monthly debt repayments. Every phone is genuine Australian stock, factory unlocked, and delivered with free express courier shipping Australia-wide.',
    answer: 'All handsets in our store are purchased outright as a simple, transparent e-commerce transaction. There are no complicated lock-in financing contracts or confusing monthly debt repayments. Every phone is genuine Australian stock, factory unlocked, and delivered with free express courier shipping Australia-wide.',
    displayOrder: 2,
    active: true
  },
  {
    id: 'faq-3',
    q: 'Do I have to bundle a phone with a mobile plan?',
    question: 'Do I have to bundle a phone with a mobile plan?',
    a: 'No! You have complete freedom. You can purchase a handset outright without any mobile plan, bring your own existing phone to our SIM-only month-to-month plans, or combine both anytime.',
    answer: 'No! You have complete freedom. You can purchase a handset outright without any mobile plan, bring your own existing phone to our SIM-only month-to-month plans, or combine both anytime.',
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
    await plansCol.updateMany(
      { id: { $in: ['plan-10gb', 'plan-29gb', 'plan-11144156', 'plan-20gb', 'plan-50gb'] } },
      { $set: { active: false, updatedAt: new Date() } }
    );
    for (const p of PLANS) {
      await plansCol.updateOne(
        { id: p.id },
        { $set: p, $setOnInsert: { createdAt: new Date() } },
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
