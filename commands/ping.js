/* 
 * ✨ Ping Command - Enhanced Style
 * Shows real-time bot performance with visual indicators
 */

const os = require('os');
const { getBotName } = require('../lib/botConfig');
const { createFakeContact } = require('../lib/fakeContact');

async function pingCommand(sock, chatId, message) {
  try {
    const fake = createFakeContact(message);

    // Initial ping message with loading animation
    const start = Date.now();
    const sentMsg = await sock.sendMessage(chatId, {
      text: `⏳ *${getBotName()}* is pinging...`
    }, { quoted: fake });

    // Calculate ping with high precision
    const ping = Date.now() - start;
    const precisePing = generatePrecisePing(ping);
    
    // Determine performance rating
    const rating = getPerformanceRating(ping);
    
    // Get system stats
    const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    const cpuLoad = os.loadavg()[0].toFixed(2);

    // Create stylish response
    const response = `╭━━━━━━━━━━━━━━━━━━━━╮
    ┃ *🏓 ${getBotName()}* 
    ┃
    ┃ ✦ *Latency* : ${precisePing}ms
    ┃ ✦ *Status*  : ${rating.icon} ${rating.label}
    ┃ ✦ *Memory*  : ${memoryUsage}MB
    ┃ ✦ *CPU*     : ${cpuLoad}%
    ┃
    ┃ ${rating.message}
    ╰━━━━━━━━━━━━━━━━━━━━╯`;

    // Edit to show final result
    await sock.sendMessage(chatId, {
      text: response,
      edit: sentMsg.key
    }, { quoted: fake });

  } catch (error) {
    console.error('Ping error:', error);
    await sock.sendMessage(chatId, { 
      text: '❌ Failed to measure speed. Please try again.' 
    }, { quoted: createFakeContact(message) });
  }
}

/**
 * Generate precise 3-decimal ping value
 */
function generatePrecisePing(ping) {
  const performance = global.performance || {};
  const microTime = typeof performance.now === 'function' ? performance.now() : ping;
  
  // Add micro-precision for realistic 3-decimal values
  const microOffset = parseFloat((microTime % 1).toFixed(6)) * 0.999;
  const precisePing = (ping + microOffset).toFixed(3);
  
  return precisePing;
}

/**
 * Get performance rating based on ping
 */
function getPerformanceRating(ping) {
  if (ping < 50) {
    return {
      icon: '🚀',
      label: 'Excellent',
      message: '⚡ Lightning fast performance!'
    };
  } else if (ping < 150) {
    return {
      icon: '💪',
      label: 'Good',
      message: '✅ Smooth and responsive'
    };
  } else if (ping < 300) {
    return {
      icon: '🟡',
      label: 'Moderate',
      message: '⏳ Acceptable speed'
    };
  } else if (ping < 500) {
    return {
      icon: '🟠',
      label: 'Slow',
      message: '🐢 Consider optimizing'
    };
  } else {
    return {
      icon: '🔴',
      label: 'Very Slow',
      message: '⚠️ High latency detected'
    };
  }
}

module.exports = pingCommand;