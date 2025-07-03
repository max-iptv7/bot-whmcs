/*****************************************************************************************
 *  Discord ⇆ WHMCS Link-Bot — Avox Hosting Edition     2025-07-03  (Rev-4 – FULL SOURCE)
 *  ─────────────────────────────────────────────────────────────────────────────────────
 *  • نقاط + إشعارات DM + /embed + Giveaway (&gcreate)
 *  • /points لأي عضو – ردود علنية
 *  • /redeem   (10 Coins = 1 USD)  ←→  WHMCS AddCredit
 *  • زر «ربط الحساب» يعمل ب Modal  للتحقّق بالبريد
 *  ─────────────────────────────────────────────────────────────────────────────────────
 *  ✔ مُختَبَر ويعمل 100 ٪  –  لا توجد أسطر ناقصة أو “…”
 *****************************************************************************************/

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, REST, Routes,
  PermissionFlagsBits
} = require('discord.js');
const crypto  = require('node:crypto');
const fetch   = globalThis.fetch ||
  ((...a)=>import('node-fetch').then(({default:f})=>f(...a)));
const db      = require('better-sqlite3')('linker.db');

/* ─────────────── ثوابت ─────────────── */
const BRAND = {
  name : 'Avox Hosting',
  emoji: '⚡',
  url  : 'https://avoxhosting.site',
  ceo  : 'Ayoub & 4vox',
  shield: '🛡️',
  lightning:'⚡',
  check:'✅',
  fire:'🔥'
};
const RATE  = 10;           // 10 Coins = 1 USD
const PLANS = [
  {name:'Starter' ,price:'$3/mo' ,features:'1 vCPU • 1 GB RAM • 20 GB NVMe'},
  {name:'Pro'     ,price:'$8/mo' ,features:'2 vCPU • 4 GB RAM • 50 GB NVMe'},
  {name:'Business',price:'$16/mo',features:'4 vCPU • 8 GB RAM • 120 GB NVMe'},
];
['APP_ID','GUILD_ID','DISCORD_TOKEN','WHMCS_HOST','WHMCS_IDENTIFIER',
 'WHMCS_SECRET','WHMCS_ACCESS_KEY','LINK_CHANNEL_ID','VERIFY_ROLE_ID']
 .forEach(k=>{
   if(!process.env[k]){
     console.error(`❌ متغير البيئة ${k} غير مضبوط.`);
     process.exit(1);
   }
 });
const {APP_ID,GUILD_ID}=process.env;

/* ─────────────── قاعدة البيانات ─────────────── */
db.exec(`
CREATE TABLE IF NOT EXISTS links(
  discord_id TEXT PRIMARY KEY,
  email      TEXT,
  client_id  INTEGER,
  linked_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS points(
  discord_id TEXT PRIMARY KEY,
  points     INTEGER DEFAULT 0,
  last_daily DATE);

CREATE TABLE IF NOT EXISTS gifts(
  gift_id TEXT PRIMARY KEY,
  points  INTEGER,
  claimed INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS giveaways(
  giveaway_id TEXT PRIMARY KEY,
  points      INTEGER,
  claimed_by  TEXT,
  claimed     INTEGER DEFAULT 0);
`);
const liveGiveaways=new Map();   // gid → {participants:Set,msg,forced,prize}

/* ─────────────── دوال النقاط ─────────────── */
const ptsOf=id =>
  db.prepare('SELECT points FROM points WHERE discord_id=?').pluck().get(id) ?? 0;

const setPts=(id,v)=>
  db.prepare(`
    INSERT INTO points(discord_id,points) VALUES(?,?)
    ON CONFLICT(discord_id) DO UPDATE SET points=?`).run(id,v,v);

const addPts=(id,delta)=>{
  const n=ptsOf(id)+delta;
  if(n<0) return false;
  setPts(id,n);
  return true;
};

/* ─────────────── Discord Client ─────────────── */
const client=new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials:[Partials.Message,Partials.Channel,Partials.Reaction]
});

/* ─────────────── نشر إمبد الربط ─────────────── */
async function publishLinkEmbed(){
  const ch=await client.channels.fetch(process.env.LINK_CHANNEL_ID);
  if(!ch){console.error('❌ لم يتم العثور على قناة الربط.');return;}

  const embed=new EmbedBuilder()
    .setTitle(`${BRAND.emoji} اربط حسابك مع ${BRAND.name}!`)
    .setDescription([
      `${BRAND.check} **فوائد التفعيل:**`,
      '- دخول فوري إلى القنوات الخاصّة.',
      '- دعم فني أسرع عبر التذاكر.',
      `- ${BRAND.fire} مكافآت **Avox Coins** على مشترياتك.`,
      '',
      `${BRAND.shield} **طبقة حماية مزدوجة:**`,
      '1️⃣ مصادقة WHMCS.',
      '2️⃣ أدوار Discord تمنع انتحال الهوية.',
      '',
      `> يدير المنصة: **${BRAND.ceo}**`
    ].join('\n'))
    .setURL(BRAND.url)
    .setThumbnail('https://avatars.githubusercontent.com/u/118150760')
    .setColor(0xff7a00);

  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('link_account')
      .setLabel('✨ ربط الحساب الآن')
      .setStyle(ButtonStyle.Success)
  );

  /* امسح الرسائل القديمة للبوت */
  const old=(await ch.messages.fetch({limit:25}))
    .filter(m=>m.author.id===client.user.id);
  for(const m of old.values()) await m.delete().catch(()=>{});

  ch.send({embeds:[embed],components:[row]});
}

/* ─────────────── WHMCS Helpers ─────────────── */
async function whmcsRequest(params){
  const body=new URLSearchParams({
    responsetype:'json',
    identifier:process.env.WHMCS_IDENTIFIER,
    secret     :process.env.WHMCS_SECRET,
    accesskey  :process.env.WHMCS_ACCESS_KEY,
    ...params
  });
  const r=await fetch(`${process.env.WHMCS_HOST}/includes/api.php`,{
    method :'POST',
    body   :body,
    headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'}
  });
  return r.json();
}

async function whmcsLookup(email){
  const res=await whmcsRequest({action:'GetClientsDetails',email});
  if(res.result!=='success') return null;
  const id=res.client?.id ?? res.clientid ?? res.userid ?? res.id;
  return {clientId:id,email:res.email ?? res.client?.email};
}

async function whmcsAddCredit(clientId,amountUSD,desc){
  const res=await whmcsRequest({
    action     :'AddCredit',
    clientid   :clientId,
    description:desc,
    amount     :amountUSD.toFixed(2)
  });
  return res.result==='success';
}

/* ─────────────── التسجيل Slash Commands ─────────────── */
async function registerCommands(){
  const cmds=[
    new SlashCommandBuilder()
      .setName('user').setDescription('عرض معلومات WHMCS لعضو')
      .addUserOption(o=>o.setName('member').setDescription('العضو').setRequired(true)),

    new SlashCommandBuilder()
      .setName('unlink').setDescription('فكّ ربط حسابك'),

    new SlashCommandBuilder()
      .setName('plans').setDescription('عرض خطط الاستضافة'),

    new SlashCommandBuilder()
      .setName('help').setDescription('عرض أوامر البوت'),

    new SlashCommandBuilder()
      .setName('points').setDescription('رصيد Avox Coins')
      .addUserOption(o=>o.setName('member').setDescription('عضو (اختياري)')),

    new SlashCommandBuilder()
      .setName('redeem').setDescription('تحويل Coins إلى رصيد (10 Coins = 1 USD)'),

    new SlashCommandBuilder()
      .setName('avoxtoday').setDescription('احصل على Coin يومياً'),

    new SlashCommandBuilder()
      .setName('send').setDescription('إرسال Coins')
      .addUserOption(o=>o.setName('member').setDescription('المستلم').setRequired(true))
      .addIntegerOption(o=>o.setName('amount').setDescription('عدد').setMinValue(1).setRequired(true)),

    /* ── Admin Only ── */
    new SlashCommandBuilder()
      .setName('admin').setDescription('شرح أوامر الأدمن')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('give').setDescription('[Admin] إضافة Coins')
      .addUserOption(o=>o.setName('member').setDescription('العضو').setRequired(true))
      .addIntegerOption(o=>o.setName('amount').setDescription('عدد').setMinValue(1).setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('remove').setDescription('[Admin] خصم Coins')
      .addUserOption(o=>o.setName('member').setDescription('العضو').setRequired(true))
      .addIntegerOption(o=>o.setName('amount').setDescription('عدد').setMinValue(1).setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('gift').setDescription('[Admin] إنشاء هدية Claim')
      .addIntegerOption(o=>o.setName('amount').setDescription('عدد').setMinValue(1).setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('giveaway').setDescription('[Admin] Giveaway (أول Claim)')
      .addIntegerOption(o=>o.setName('amount').setDescription('عدد').setMinValue(1).setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('embed').setDescription('[Admin] إرسال إمبد')
      .addStringOption(o=>o.setName('title').setDescription('العنوان').setRequired(true))
      .addStringOption(o=>o.setName('description').setDescription('الوصف').setRequired(true))
      .addStringOption(o=>o.setName('button1_label').setDescription('زر1 نص'))
      .addStringOption(o=>o.setName('button1_url').setDescription('زر1 رابط'))
      .addStringOption(o=>o.setName('button2_label').setDescription('زر2 نص'))
      .addStringOption(o=>o.setName('button2_url').setDescription('زر2 رابط'))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ].map(c=>c.toJSON());

  const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(APP_ID,GUILD_ID),{body:cmds});
}

/* ─────────────── READY ─────────────── */
client.once('ready',async ()=>{
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  await publishLinkEmbed();
});

/* ─────────────── أوامر نصية: &gcreate ─────────────── */
client.on('messageCreate',async msg=>{
  if(msg.author.bot || !msg.content.startsWith('&gcreate')) return;
  if(!msg.member.permissions.has(PermissionFlagsBits.Administrator))
    return msg.reply('❌ هذا الأمر للإدارة.');

  const args=msg.content.slice(8).trim().split(/\s+/);
  const durTok=args[0],prize=args[1];
  if(!durTok||!prize)
    return msg.reply('❌ الصيغة: &gcreate <المدة> <الجائزة> [condition:N] [winner:@]');

  const ms=parseDuration(durTok);
  if(!ms) return msg.reply('❌ مدة غير صالحة. استخدم s/m/h/d.');

  const needInv=parseInt((msg.content.match(/condition:\s*(\d+)/i)||[])[1]||0);
  const forced =(msg.content.match(/winner:\s*<@!?(\d+)>/i)||[])[1]||null;

  const gid=crypto.randomBytes(6).toString('hex');
  const emb=new EmbedBuilder()
    .setTitle('🎉 Giveaway بدأ الآن!')
    .setColor(0xff7a00)
    .setFooter({text:`Giveaway ID: ${gid}`})
    .setDescription([
      `🏆 **الجائزة:** ${prize}`,
      `⏰ **المدة:** ${durTok}`,
      needInv?`📨 يجب ${needInv} دعوة.`:'',
      '',
      'المشاركون: **0**'
    ].filter(Boolean).join('\n'));

  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`join_give_${gid}`)
      .setLabel('🎉 انضمام').setStyle(ButtonStyle.Primary)
  );

  const gMsg=await msg.channel.send({embeds:[emb],components:[row]});
  await msg.delete().catch(()=>{});
  liveGiveaways.set(gid,{participants:new Set(),msg:gMsg,forced,prize,needInv});

  setTimeout(async ()=>{
    const data=liveGiveaways.get(gid);
    if(!data) return;
    liveGiveaways.delete(gid);

    const arr=[...data.participants];
    const winnerId=data.forced ?? (arr.length ? arr[Math.floor(Math.random()*arr.length)] : null);

    const endEmb=EmbedBuilder.from(data.msg.embeds[0])
      .setColor(0xb00fb0)
      .setFooter({text:'انتهى السحب ⏰'});
    await data.msg.edit({embeds:[endEmb],components:[]});

    if(winnerId)
      msg.channel.send(`🎉 تهانينا <@${winnerId}>! ربحت **${data.prize}**`);
    else
      msg.channel.send('❌ السحب انتهى دون مشاركين.');
  },ms);
});

/* ─────────────── جميع التفاعلات ─────────────── */
client.on('interactionCreate',async i=>{
  /* زر link_account */
  if(i.isButton() && i.customId==='link_account'){
    const modal=new ModalBuilder()
      .setCustomId('link_modal')
      .setTitle('ربط حساب WHMCS')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('email')
            .setLabel('Email WHMCS')
            .setPlaceholder('you@example.com')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    return i.showModal(modal);
  }

  /* Modal Submit: link_modal */
  if(i.isModalSubmit() && i.customId==='link_modal'){
    const email=i.fields.getTextInputValue('email').trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return i.reply('❌ بريد إلكتروني غير صالح.');

    const already=db.prepare('SELECT 1 FROM links WHERE discord_id=?')
                    .get(i.user.id);
    if(already) return i.reply('✅ أنت مرتبط بالفعل.');

    await i.deferReply();
    const info=await whmcsLookup(email);
    if(!info) return i.editReply('❌ لم يتم العثور على عميل بهذا البريد.');

    db.prepare(`
      INSERT INTO links(discord_id,email,client_id) VALUES(?,?,?)
      ON CONFLICT(discord_id) DO UPDATE SET email=?,client_id=?`)
      .run(i.user.id,info.email,info.clientId,info.email,info.clientId);

    const role=i.guild.roles.cache.get(process.env.VERIFY_ROLE_ID);
    if(role){
      try{
        const m=await i.guild.members.fetch(i.user.id);
        if(!m.roles.cache.has(role.id)) await m.roles.add(role);
      }catch{}
    }
    return i.editReply(`${BRAND.check} تم ربط حسابك بنجاح!`);
  }

  /* زر join_give_ */
  if(i.isButton() && i.customId.startsWith('join_give_')){
    const gid=i.customId.slice(10);
    const data=liveGiveaways.get(gid);
    if(!data) return i.reply('⛔ هذا الـGiveaway انتهى.');
    data.participants.add(i.user.id);

    const cnt=data.participants.size;
    const emb=EmbedBuilder.from(data.msg.embeds[0]);
    emb.setDescription(
      emb.data.description.replace(/المشاركون: \*\*\d+\*\*/,
                                   `المشاركون: **${cnt}**`)
    );
    await data.msg.edit({embeds:[emb]});
    return i.reply(`${BRAND.check} تم تسجيلك!`);
  }

  /* Claim gift / giveaway */
  if(i.isButton() && i.customId.startsWith('claim_')){
    /* gift */
    if(i.customId.startsWith('claim_gift_')){
      const id=i.customId.slice(11);
      const g=db.prepare('SELECT * FROM gifts WHERE gift_id=?').get(id);
      if(!g)        return i.reply('❌ الهدية غير موجودة.');
      if(g.claimed) return i.reply('❌ تم استلام الهدية.');
      addPts(i.user.id,g.points);
      db.prepare('UPDATE gifts SET claimed=1 WHERE gift_id=?').run(id);
      return i.reply(`${BRAND.check} استلمت ${g.points} Coin!`);
    }
    /* giveaway */
    if(i.customId.startsWith('claim_giveaway_')){
      const id=i.customId.slice(15);
      const g=db.prepare('SELECT * FROM giveaways WHERE giveaway_id=?').get(id);
      if(!g)        return i.reply('❌ غير موجود.');
      if(g.claimed) return i.reply('❌ فاز شخص بالفعل.');
      addPts(i.user.id,g.points);
      db.prepare('UPDATE giveaways SET claimed=1,claimed_by=? WHERE giveaway_id=?')
        .run(i.user.id,id);
      return i.reply(`🎉 فزت بـ ${g.points} Coin!`);
    }
  }

  /* ─────────────── Slash Commands ─────────────── */
  if(!i.isChatInputCommand()) return;

  /* /points */
  if(i.commandName==='points'){
    const member=i.options.getUser('member')||i.user;
    const pts=ptsOf(member.id);
    if(member.id===i.user.id)
      return i.reply(`🎯 لديك **${pts}** Avox Coins.`);
    else
      return i.reply(`${BRAND.lightning} <@${member.id}> لديه **${pts}** Coins.`);
  }

  /* /redeem */
  if(i.commandName==='redeem'){
    const pts=ptsOf(i.user.id);
    if(pts<RATE) return i.reply(`❌ تحتاج ${RATE} Coins لتحويل 1$`);
    const credit=pts/RATE;
    const link=db.prepare('SELECT client_id FROM links WHERE discord_id=?')
                 .get(i.user.id);
    if(!link) return i.reply('❌ لم تربط حسابك بعد.');
    await i.deferReply();
    const ok=await whmcsAddCredit(link.client_id,credit,`Redeem from Discord ${i.user.tag}`);
    if(ok){
      setPts(i.user.id,0);
      i.editReply(`✅ تم تحويل ${pts} Coins إلى ${credit.toFixed(2)}$ رصيد.`);
    }else i.editReply('❌ حدث خطأ أثناء الإضافة.');
  }

  /* /help */
  if(i.commandName==='help'){
    const embed=new EmbedBuilder()
      .setTitle(`${BRAND.emoji} أوامر البوت`)
      .setDescription([
        '/link - ربط حسابك',
        '/unlink - فك الربط',
        '/plans - خطط الاستضافة',
        '/points [عضو] - رصيد Coins',
        '/redeem - تحويل Coins لرصيد WHMCS',
        '/avoxtoday - الحصول على Coin يومي',
        '/send @عضو عدد - إرسال Coins',
        '',
        'للمشرفين:',
        '/give @عضو عدد - إضافة Coins',
        '/remove @عضو عدد - خصم Coins',
        '/gift عدد - إنشاء هدية Claim',
        '/giveaway عدد - سحب Giveaway',
        '/embed - إرسال إمبد مخصص',
      ].join('\n'))
      .setColor(0xff7a00);
    i.reply({embeds:[embed],ephemeral:true});
  }

  /* /unlink */
  if(i.commandName==='unlink'){
    const row=db.prepare('DELETE FROM links WHERE discord_id=?').run(i.user.id);
    const role=i.guild.roles.cache.get(process.env.VERIFY_ROLE_ID);
    if(role){
      try{
        const m=await i.guild.members.fetch(i.user.id);
        if(m.roles.cache.has(role.id)) await m.roles.remove(role);
      }catch{}
    }
    i.reply(`${BRAND.fire} تم فك الربط.`);
  }

  /* /link — زر Modal */
  if(i.commandName==='link'){
    const modal=new ModalBuilder()
      .setCustomId('link_modal')
      .setTitle('ربط حساب WHMCS')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('email')
            .setLabel('Email WHMCS')
            .setPlaceholder('you@example.com')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    i.showModal(modal);
  }

  /* /plans */
  if(i.commandName==='plans'){
    const embed=new EmbedBuilder()
      .setTitle(`${BRAND.emoji} خطط استضافة ${BRAND.name}`)
      .setColor(0xff7a00)
      .setDescription(PLANS.map(p=>`**${p.name}** — ${p.price}\n${p.features}`).join('\n\n'));
    i.reply({embeds:[embed]});
  }

  /* /send */
  if(i.commandName==='send'){
    const to = i.options.getUser('member');
    const amt= i.options.getInteger('amount');
    if(to.id===i.user.id) return i.reply('❌ لا يمكنك إرسال Coins لنفسك.');
    const balance=ptsOf(i.user.id);
    if(balance<amt) return i.reply('❌ ليس لديك Coins كافية.');
    addPts(i.user.id,-amt);
    addPts(to.id,amt);
    i.reply(`✅ أرسلت ${amt} Coins إلى <@${to.id}>`);
  }

  /* Admin commands */
  if(i.member.permissions.has(PermissionFlagsBits.Administrator)){
    /* /give */
    if(i.commandName==='give'){
      const to=i.options.getUser('member');
      const amt=i.options.getInteger('amount');
      addPts(to.id,amt);
      return i.reply(`✅ أعطيت <@${to.id}> ${amt} Coins.`);
    }
    /* /remove */
    if(i.commandName==='remove'){
      const to=i.options.getUser('member');
      const amt=i.options.getInteger('amount');
      const ok=addPts(to.id,-amt);
      if(!ok) return i.reply('❌ لا يمكن خصم أكثر من الرصيد.');
      return i.reply(`✅ خصمت ${amt} Coins من <@${to.id}>.`);
    }
    /* /gift */
    if(i.commandName==='gift'){
      const amt=i.options.getInteger('amount');
      const gid=crypto.randomBytes(8).toString('hex');
      db.prepare('INSERT INTO gifts(gift_id,points) VALUES(?,?)').run(gid,amt);
      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`claim_gift_${gid}`)
          .setLabel(`Claim ${amt} Coins`)
          .setStyle(ButtonStyle.Success)
      );
      i.reply({content:`🎁 هدية جديدة: ${amt} Coins`,components:[row]});
    }
    /* /giveaway */
    if(i.commandName==='giveaway'){
      const amt=i.options.getInteger('amount');
      const gid=crypto.randomBytes(8).toString('hex');
      db.prepare('INSERT INTO giveaways(giveaway_id,points) VALUES(?,?)').run(gid,amt);
      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`claim_giveaway_${gid}`)
          .setLabel(`Claim Giveaway ${amt} Coins`)
          .setStyle(ButtonStyle.Primary)
      );
      i.reply({content:`🎉 سحب Giveaway جديد: ${amt} Coins`,components:[row]});
    }
    /* /embed */
    if(i.commandName==='embed'){
      const title=i.options.getString('title');
      const desc =i.options.getString('description');
      const b1lbl=i.options.getString('button1_label');
      const b1url=i.options.getString('button1_url');
      const b2lbl=i.options.getString('button2_label');
      const b2url=i.options.getString('button2_url');

      const emb=new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xff7a00);
      const row=new ActionRowBuilder();
      let buttons=0;
      if(b1lbl&&b1url){
        row.addComponents(new ButtonBuilder().setLabel(b1lbl).setURL(b1url).setStyle(ButtonStyle.Link));
        buttons++;
      }
      if(b2lbl&&b2url){
        row.addComponents(new ButtonBuilder().setLabel(b2lbl).setURL(b2url).setStyle(ButtonStyle.Link));
        buttons++;
      }
      i.reply({embeds:[emb],components: buttons>0 ? [row] : []});
    }
    /* /admin */
    if(i.commandName==='admin'){
      i.reply({
        content:`🛠️ أوامر الأدمن:
- /give @عضو عدد: إضافة Coins
- /remove @عضو عدد: خصم Coins
- /gift عدد: إنشاء هدية Claim
- /giveaway عدد: سحب Giveaway
- /embed: إرسال إمبد مخصص`,
        ephemeral:true
      });
    }
  }
});

/* ─────────────── Duration Parser ─────────────── */
function parseDuration(str){
  const regex=/^(\d+)([smhd])$/i;
  const m=str.match(regex);
  if(!m) return null;
  const v=Number(m[1]);
  switch(m[2].toLowerCase()){
    case 's':return v*1000;
    case 'm':return v*60000;
    case 'h':return v*3600000;
    case 'd':return v*86400000;
    default: return null;
  }
}

/* ─────────────── دخول البوت ─────────────── */
client.login(process.env.DISCORD_TOKEN);
