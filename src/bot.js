/**
 * Hollow Knight Bot - whatsapp-web.js
 *
 * Admin-only commands are silent to non-admins (no reply).
 * #kick @user -> creates an admin-only instruction to remove user (bot *cannot* kick).
 * #play <youtube_url> -> downloads audio from YouTube (ytdl-core + ffmpeg-static) and sends as audio message.
 *
 * Persistence:
 * - muted users saved to ./session/muted.json
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const SESSION_DIR = path.join(__dirname, '..', 'session');
const MUTED_FILE = path.join(SESSION_DIR, 'muted.json');
const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// load muted list from disk
let muted = new Set();
try {
  if (fs.existsSync(MUTED_FILE)) {
    const raw = fs.readFileSync(MUTED_FILE, 'utf8');
    const arr = JSON.parse(raw || '[]');
    muted = new Set(arr);
  }
} catch (e) {
  console.log('Could not load muted list:', e.message || e);
}

function saveMuted() {
  try {
    fs.writeFileSync(MUTED_FILE, JSON.stringify(Array.from(muted)), 'utf8');
  } catch (e) {
    console.log('Could not save muted list:', e.message || e);
  }
}

// Detectar la ruta de chromium según el sistema
let puppeteerConfig = {
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
};

// En Replit (Nix), usar la ruta específica
const replitChromium = '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';
if (fs.existsSync(replitChromium)) {
  puppeteerConfig.executablePath = replitChromium;
}
// En Termux/Linux normal, dejar que busque chromium en el sistema

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: puppeteerConfig
});

client.on('qr', qr => {
  console.log('🔵 Escanea este QR desde el celular viejo:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Hollow Knight Bot listo');
});

// Whitelist de IDs de admins (por si la verificación automática falla)
const ADMIN_WHITELIST = new Set([
  '267971784106012', // Tu ID
  '23266257297645', // +52 624 240 5546
]);

async function isAdmin(chat, userId) {
  if (!chat.isGroup) return false;
  
  try {
    // Extraer solo el número del ID del usuario
    const userNumber = userId.split('@')[0];
    console.log('🔍 Verificando admin para:', userNumber);
    
    // Primero verificar whitelist
    if (ADMIN_WHITELIST.has(userNumber)) {
      console.log('✅ Admin en whitelist:', userNumber);
      return true;
    }
    
    // Luego intentar verificar en el grupo
    const freshChat = await client.getChatById(chat.id._serialized);
    const participants = freshChat.participants || [];
    
    console.log('📊 Buscando en', participants.length, 'participantes...');
    
    for (let p of participants) {
      if (p.id) {
        const participantId = p.id._serialized || p.id.toString();
        const participantNumber = participantId.split('@')[0];
        
        if (participantNumber === userNumber) {
          const isAdminStatus = !!p.isAdmin;
          console.log('✅ Usuario encontrado. isAdmin:', isAdminStatus);
          return isAdminStatus;
        }
      }
    }
    
    console.log('❌ No es admin');
    return false;
  } catch (e) {
    console.log('❌ Error:', e.message);
    return false;
  }
}

function getSenderId(msg) {
  if (msg.from && msg.from.includes('@g.us')) {
    // En grupos, siempre usar msg.author (es el ID real del usuario)
    return msg.author || msg.from;
  }
  return msg.from;
}

async function tryDelete(msg) {
  try {
    await msg.delete(true);
    return true;
  } catch (e) {
    console.log('Delete failed:', e.message || e);
    return false;
  }
}

async function requireAdminOrSilent(msg) {
  try {
    const chat = await msg.getChat();
    const sender = getSenderId(msg);
    console.log('Sender ID from message:', sender);
    const ok = await isAdmin(chat, sender);
    console.log('Admin check result:', ok);
    return ok;
  } catch (e) {
    console.log('admin check failed:', e);
    return false;
  }
}

async function sendAudio(chat, filePath) {
  const media = MessageMedia.fromFilePath(filePath);
  await chat.sendMessage(media, { sendAudioAsVoice: true });
}

async function downloadYouTubeAudio(url, outPath) {
  const tempPath = outPath + '.mp4';
  return new Promise((resolve, reject) => {
    try {
      const stream = ytdl(url, { filter: 'audioonly' });
      ffmpeg(stream)
        .audioBitrate(128)
        .save(tempPath)
        .on('end', () => {
          ffmpeg(tempPath)
            .outputOptions(['-vn','-acodec libopus','-b:a 64k'])
            .save(outPath)
            .on('end', () => {
              try { fs.unlinkSync(tempPath); } catch (e) {}
              resolve(outPath);
            })
            .on('error', err => reject(err));
        })
        .on('error', err => reject(err));
    } catch (e) {
      reject(e);
    }
  });
}

client.on('message_create', async msg => {
  if (msg.fromMe) return;
  
  try {
    console.log('🔔 Procesando comando:', msg.body);
    const chat = await msg.getChat();
    const sender = getSenderId(msg);

    if (sender && muted.has(sender)) {
      await tryDelete(msg);
      return;
    }

    const body = (msg.body || '').trim();
    const text = body.toLowerCase();

    if (text === '#menu' || text === '#help' || text === '#hola') {
      const menu = [
        '🦋 *HOLLOW KNIGHT BOT* 🦋',
        '',
        '⚔️ *ADMIN*',
        '#tag [msg] - Notificar a todos',
        '#mute (reply) - Silenciar usuario',
        '#unmute (reply) - Des-silenciar',
        '#del - Borrar mensaje',
        '#kick (reply) - Expulsar usuario',
        '',
        '🎮 *JUEGOS*',
        '#dado - Tirar dado',
        '#moneda - Cara o cruz',
        '#8ball - Bola mágica',
        '#ppt p|r|t - Piedra, papel, tijera',
        '#ruleta - Número random',
        '#adivina - Adivinanza',
        '',
        '😄 *DIVERSIÓN*',
        '#chiste - Contar chiste',
        '#piropo - Piropo random',
        '#insulto - Insulto gracioso',
        '#meme - Imagen random'
      ].join('\n');
      await chat.sendMessage(menu);
      return;
    }

    if (text === '#tag' || text.startsWith('#tag ')) {
      console.log('Comando #tag recibido');
      
      const ok = await requireAdminOrSilent(msg);
      if (!ok) return;
      
      if (!chat.isGroup) {
        await chat.sendMessage('⚠️ Este comando solo funciona en grupos.');
        return;
      }
      
      try {
        let participants = chat.participants || [];
        
        if (participants.length === 0) {
          const groupChat = await client.getChatById(chat.id._serialized);
          participants = groupChat.participants || [];
        }
        
        if (participants.length === 0) {
          await chat.sendMessage('⚠️ No se pudieron obtener los participantes del grupo.');
          return;
        }
        
        let mentions = [];
        
        for (let p of participants) {
          try {
            const contact = await client.getContactById(p.id._serialized);
            mentions.push(contact);
          } catch (e) {
            mentions.push(p.id._serialized);
          }
        }
        
        const customMessage = body.slice(4).trim() || '🦋 Atención a todos';
        
        console.log('Enviando mensaje con', mentions.length, 'menciones ocultas');
        await chat.sendMessage(customMessage, { mentions });
      } catch (e) {
        console.log('Error en #tag:', e.message || e);
        await chat.sendMessage('⚠️ Error al mencionar a todos: ' + (e.message || 'desconocido'));
      }
      return;
    }

    if (text.startsWith('#mute') && !text.startsWith('#mutelist')) {
      const ok = await requireAdminOrSilent(msg);
      if (!ok) return;
      
      try {
        if (!msg.hasQuotedMsg) {
          await chat.sendMessage('⚠️ Responde a un mensaje con #mute para silenciar a ese usuario.');
          return;
        }
        const quoted = await msg.getQuotedMessage();
        const targetId = getSenderId(quoted);
        muted.add(targetId);
        console.log('Muteado:', targetId);
        saveMuted();
        await chat.sendMessage('🔇 *Usuario silenciado*');
      } catch (e) {
        console.log('Error en #mute:', e.message || e);
      }
      return;
    }

    if (text.startsWith('#unmute')) {
      const ok = await requireAdminOrSilent(msg);
      if (!ok) return;
      
      try {
        if (!msg.hasQuotedMsg) {
          await chat.sendMessage('⚠️ Responde a un mensaje con #unmute para des-silenciar a ese usuario.');
          return;
        }
        const quoted = await msg.getQuotedMessage();
        const targetId = getSenderId(quoted);
        muted.delete(targetId);
        console.log('Des-muteado:', targetId);
        saveMuted();
        await chat.sendMessage('🔊 *Usuario des-silenciado*');
      } catch (e) {
        console.log('Error en #unmute:', e.message || e);
      }
      return;
    }

    if (text === '#mutelist') {
      if (muted.size === 0) {
        await chat.sendMessage('📭 No hay usuarios silenciados.');
        return;
      }
      const list = Array.from(muted).map(id => `• ${id}`).join('\\n');
      await chat.sendMessage('🔇 *Usuarios silenciados:*\\n' + list);
      return;
    }

    if (text === '#del') {
      const ok = await requireAdminOrSilent(msg);
      if (!ok) return;
      if (!msg.hasQuotedMsg) return;
      try {
        const quoted = await msg.getQuotedMessage();
        await quoted.delete(true);
        await msg.reply('🗑️ Mensaje eliminado.');
      } catch (e) {
        await msg.reply('No se pudo eliminar el mensaje.');
      }
      return;
    }

    if (text.startsWith('#kick')) {
      const ok = await requireAdminOrSilent(msg);
      if (!ok) return;
      
      try {
        if (!msg.hasQuotedMsg) {
          await chat.sendMessage('⚠️ Responde a un mensaje con #kick para expulsar a ese usuario.');
          return;
        }
        
        const quoted = await msg.getQuotedMessage();
        const targetId = getSenderId(quoted);
        
        await chat.removeParticipants([targetId]);
        await chat.sendMessage('🔨 *Usuario expulsado del grupo*');
      } catch (e) {
        console.log('Error en #kick:', e.message || e);
        await chat.sendMessage('⚠️ El bot no puede expulsar. Solo admins pueden expulsar usuarios.');
      }
      return;
    }

    if (text === '#chiste') {
      const jokes = [
        '—¿Qué le dice un primer piso a un segundo piso? — ¡Sube, que está muy aburrido aquí abajo!',
        '—¿Por qué los programadores confunden Halloween y Navidad? — Porque OCT 31 == DEC 25.',
        '—¿Qué hace una abeja en el gimnasio? — ¡Zum-ba!',
        '—¿Cómo se llama un boomerang que no vuelve? — Palo.',
        '—¿Cuál es el colmo de un matemático? — Morirse de parábola.',
        '—¿Por qué los pescadores son secretistas? — Porque no sueltan prenda.',
        '—¿Qué hace un croissant en la clase de kung-fu? — Historieta.',
        '—¿Cuál es la capital de Alemania? — La A.',
        '—¿Qué le dice un Terminator a un bar? — Quiero un trago... Y VOLVERE.',
        '—¿Cómo llamas a un oso sin dientes? — Gomoso.',
        '—¿Qué le dice un zapato a otro? — Vámonos, que esto apesta.',
        '—¿Cuál es el colmo de un panadero? — Que le salga pan de su propia boca.',
        '—¿Por qué el libro de matemáticas se suicidó? — Porque tenía demasiados problemas.',
        '—¿Qué hace un plátano en el banco? — ¡Dinero en rama!',
        '—¿Cómo se llama un detective argentino? — Sherlock Omes.',
        '—¿Qué le dice un peluca a otro? — Eres un completo desgreñado.',
        '—¿Por qué la silla fue al psicólogo? — Porque tenía problemas para sentarse.',
        '—¿Cuál es la mejor forma de no caer? — Estar acostado desde el principio.',
        '—¿Qué hace un ninja en la cocina? — ¡Sushi-do!',
        '—¿Por qué los esqueletos no tienen miedo? — Porque no tienen agallas.',
        '—¿Cómo se llama un reloj que no funciona? — ¡Perfecto! Sirve dos veces al día.',
        '—¿Qué le dice un pez a otro? — Nada, solo agua bajo el puente.',
        '—¿Por qué los bancos son tan seguros? — Porque tienen muchos ahorros.',
        '—¿Qué hace un techo en la guerra? — ¡Cubrirse!',
        '—¿Cuál es el colmo de un portero? — Tener una llave con la que no puede entrar.',
        '—¿Por qué las hormigas nunca se enferman? — Porque tienen inmunidad.',
        '—¿Qué le pregunta un gato a su novia? — ¿Me mimas o me maldices?',
        '—¿Cómo se llama un tornillo que se vuelve loco? — ¡Desatornillado!',
        '—¿Por qué fue el número 7 a la cárcel? — Porque había robado un 8.',
        '—¿Qué hace un ciego en una biblioteca? — Nada, no puede ver los libros.'
      ];
      const j = jokes[Math.floor(Math.random()*jokes.length)];
      return chat.sendMessage(j);
    }

    if (text.startsWith('#8ball')) {
      const answers = ['Sí', 'No', 'Tal vez', 'Probablemente', 'Definitivamente no', 'Pregunta luego'];
      const r = answers[Math.floor(Math.random()*answers.length)];
      return chat.sendMessage('🎱 ' + r);
    }

    if (text === '#adivina') {
      const riddles = [
        {q:'Blanca por dentro, verde por fuera. Si quieres que te lo diga, espera.', a:'la pera'},
        {q:'Tiene agujas pero no pincha, da vueltas y no es rueda.', a:'el reloj'}
      ];
      const r = riddles[Math.floor(Math.random()*riddles.length)];
      return chat.sendMessage('*Adivinanza:* ' + r.q + '\\n(Responde con #respuesta <tu respuesta>)');
    }

    if (text.startsWith('#respuesta')) {
      const resp = body.split(' ').slice(1).join(' ').trim().toLowerCase();
      if (!resp) return;
      if (resp.includes('pera')) return chat.sendMessage('✅ Correcto: La pera');
      if (resp.includes('reloj')) return chat.sendMessage('✅ Correcto: El reloj');
      return chat.sendMessage('❌ Intento registrado. Sigue intentando.');
    }

    if (text === '#meme' || text === '#imagen') {
      const assetsDir = path.join(__dirname, '..', 'assets');
      if (!fs.existsSync(assetsDir)) return chat.sendMessage('No hay assets cargados.');
      const imgs = fs.readdirSync(assetsDir).filter(f => /\\.(png|jpe?g|gif)$/i.test(f));
      if (imgs.length === 0) return chat.sendMessage('No hay imágenes en assets.');
      const pick = imgs[Math.floor(Math.random()*imgs.length)];
      const media = MessageMedia.fromFilePath(path.join(assetsDir, pick));
      return chat.sendMessage(media);
    }

    if (text === '#insulto') {
      const insults = [
        'Eres tan aburrido que en tu funeral la gente se duerme.',
        'Tu cara es como un accidente de tránsito—me da pena mirarlo.',
        'Tienes la personalidad de una piedra, solo que menos interesante.',
        'Eres tan inteligente que necesitas instrucciones para respirar.',
        'Tu sentido del humor es como tu belleza: inexistente.',
        'Podrías ser la cura para el insomnio—solo hablando.',
        'Eres tan aburrido que los insectos tienen una vida social mejor.',
        'Tu conversación es como una película de 3 horas: innecesariamente larga.',
        'Tienes menos encanto que un cubo de basura.',
        'Eres tan desagradable que hasta tú mismo te bloquerías en redes sociales.',
        'Tu carisma es tan bajo que la gente se aleja cuando te acercas.',
        'Eres tan plano que los mapas te ponen como referencia.',
        'Tienes menos éxito que una puerta giratoria en un edificio recto.',
        'Tu inteligencia es inversamente proporcional a tu confianza.',
        'Eres tan inútil que hasta tu reflejo te deserta.',
        'Tienes menos movimiento que una estatua en un museo cerrado.',
        'Eres tan mediocre que los diccionarios te ponen como foto de referencia.',
        'Tu existencia es más confusa que instrucciones en sueco.',
        'Eres tan desagradable que hasta los gatos te evitan.',
        'Tienes menos impacto que un susurro en una tormenta.'
      ];
      return chat.sendMessage(insults[Math.floor(Math.random()*insults.length)]);
    }

    if (text === '#piropo') {
      const p = [
        'Eres la luz del modo noche.',
        'Si fueras bug, sería feliz depurarte.',
        'Tienes más charisma que Wi-Fi abierto.',
        'Eres más atractivo que una pantalla OLED.',
        'Si fueras un archivo, sería un PDF leyendo.',
        'Tu sonrisa es mejor que tener 100% de batería.',
        'Eres como una conexión a internet: imprescindible.',
        'Tu belleza hace crash los servidores.',
        'Si fueras código, serías open source.',
        'Tienes más brillo que un nuevo iPhone.',
        'Tu sonrisa ilumina más que mil soles.',
        'Si la belleza fuera un delito, estarías en la cárcel de por vida.',
        'Tienes los ojos más bonitos que las estrellas del cielo.',
        'Eres como un ángel que se perdió en la tierra.',
        'Tu presencia hace que todo sea mejor.',
        'Eres tan hermoso que hasta el espejo se sonroja.',
        'Si fueras helado, sería pistacho (mi sabor favorito).',
        'Tu sonrisa es contagiosa—acabo de infectarme.',
        'Eres el tipo de persona que hace que todos quieran ser mejores.',
        'Tu belleza no necesita filtros, ni maquillaje, ni photoshop.',
        'Tienes una energía que atrae a la gente como los imanes.',
        'Eres tan especial que mereces estar en un museo.',
        'Si fueras fruta, serías mango (dulce y delicioso).',
        'Tu risa es la mejor música que he escuchado.',
        'Eres la definición de perfección hecha persona.',
        'Tu elegancia es incomparable.',
        'Tienes un aura que brilla más que el oro.',
        'Eres el motivo por el que creo en la magia.',
        'Si los ángeles existieran, te pedirían consejos de estilo.',
        'Tu belleza es arte puro.'
      ];
      return chat.sendMessage(p[Math.floor(Math.random()*p.length)]);
    }

    if (text === '#dado') {
      return chat.sendMessage('🎲 ' + (Math.floor(Math.random()*6)+1));
    }

    if (text === '#moneda') {
      return chat.sendMessage(Math.random() < 0.5 ? 'Cara' : 'Cruz');
    }

    if (text === '#ruleta') {
      return chat.sendMessage('🎯 ' + (Math.floor(Math.random()*10)+1));
    }

    if (text.startsWith('#ppt')) {
      const arg = body.split(' ')[1] || '';
      const map = {p:'Piedra', r:'Papel', t:'Tijera'};
      const choices = ['p','r','t'];
      const bot = choices[Math.floor(Math.random()*choices.length)];
      if (!map[arg]) return chat.sendMessage('Usa: #ppt p|r|t (p=piedra, r=papel, t=tijera)');
      const result = (arg === bot) ? 'Empate' : ((arg === 'p' && bot === 't') || (arg==='r' && bot==='p') || (arg==='t' && bot==='r')) ? 'Ganaste' : 'Perdiste';
      return chat.sendMessage(`Tu: ${map[arg]} vs Bot: ${map[bot]} -> ${result}`);
    }

    if (text === '#getid') {
      return chat.sendMessage('Tu ID: ' + sender);
    }

    if (text.startsWith('#play')) {
      try {
        const parts = body.split(' ').slice(1);
        if (parts.length === 0) {
          await chat.sendMessage('Usa: #play <youtube_url>');
          return;
        }
        
        const url = parts[0];
        if (!url.startsWith('http')) {
          return chat.sendMessage('Por ahora #play requiere una URL directa de YouTube (ej: https://www.youtube.com/watch?v=...)');
        }
        
        const id = Date.now();
        const outPath = path.join(DOWNLOADS_DIR, `track-${id}.ogg`);
        await chat.sendMessage('🔊 Descargando y procesando audio, espera por favor...');
        
        try {
          const res = await downloadYouTubeAudio(url, outPath);
          if (!res) return chat.sendMessage('No se pudo descargar el audio.');
          await sendAudio(chat, res);
          try { fs.unlinkSync(res); } catch(e) {}
        } catch (downloadErr) {
          console.log('Download failed:', downloadErr.message);
          await chat.sendMessage('🎵 *Audio de YouTube:*\n' + url);
        }
      } catch (e) {
        console.log('play error', e.message || e);
        await chat.sendMessage('⚠️ Error. Intenta con otro enlace.');
      }
      return;
    }

  } catch (e) {
    console.log('Message handler error', e && (e.stack || e.message) || e);
  }
});

client.initialize();
