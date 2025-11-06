var CONFIG = {
  notificationEmail: 'ahmetyigit@teksan.com',
  contextLineCount: 3,
  maxEmailLines: 80,
  storagePrefix: 'websiteMonitor::',
  timeZone: 'Europe/Istanbul'
};

var WEBSITES = [
  {
    name: 'Website 1',
    url: 'http://government.ru/en/docs/'
  },
  {
    name: 'Website 2',
    url: 'https://www.tet.org.tr/tr/ihracat/2025'
  }
  // Yeni web sitelerini buraya ekleyebilirsiniz.
];

function checkWebsites() {
  var properties = PropertiesService.getScriptProperties();
  var errors = [];

  WEBSITES.forEach(function (site) {
    try {
      var fetchResult = fetchWebsiteContent(site.url);
      if (fetchResult.statusCode >= 400) {
        errors.push(site.name + ' (' + site.url + '): HTTP ' + fetchResult.statusCode);
        return;
      }

      var normalizedContent = normalizeContent(fetchResult.content);
      var storageKey = buildStorageKey(site.name);
      var previousContent = loadContent(properties, storageKey);

      if (previousContent && previousContent !== normalizedContent) {
        var diffSnippet = buildDiffSnippet(previousContent, normalizedContent);
        if (!diffSnippet) {
          diffSnippet = fallbackDiff(normalizedContent);
        }
        sendChangeEmail(site, diffSnippet, fetchResult.statusCode);
      }

      saveContent(properties, storageKey, normalizedContent);
    } catch (error) {
      errors.push(site.name + ' (' + site.url + '): ' + error.message);
    }
  });

  if (errors.length) {
    Logger.log('Aşağıdaki siteler için hata oluştu: ' + errors.join('; '));
  }
}

function fetchWebsiteContent(url) {
  var response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true
  });

  return {
    statusCode: response.getResponseCode(),
    content: response.getContentText()
  };
}

function normalizeContent(html) {
  if (!html) {
    return '';
  }

  var sanitized = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|section|article|header|footer|nav|main|aside)>/gi, '\n')
    .replace(/<\/(h[1-6]|table|tbody|thead|tfoot)>/gi, '\n')
    .replace(/<td[^>]*>/gi, '\t')
    .replace(/<th[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n');

  sanitized = sanitized
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return sanitized;
}

function buildDiffSnippet(oldContent, newContent) {
  var oldLines = toLineArray(oldContent);
  var newLines = toLineArray(newContent);

  if (!oldLines.length && !newLines.length) {
    return '';
  }

  var segments = calculateDiffSegments(oldLines, newLines);
  var blocks = groupDiffBlocks(segments, CONFIG.contextLineCount);
  return formatDiffBlocks(blocks, CONFIG.maxEmailLines);
}

function toLineArray(text) {
  return text
    .split('\n')
    .map(function (line) {
      return line.trim();
    })
    .filter(function (line) {
      return line.length > 0;
    });
}

function calculateDiffSegments(oldLines, newLines) {
  var m = oldLines.length;
  var n = newLines.length;
  var dp = [];

  for (var i = 0; i <= m; i++) {
    dp[i] = [];
    for (var j = 0; j <= n; j++) {
      dp[i][j] = 0;
    }
  }

  for (i = m - 1; i >= 0; i--) {
    for (j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  var segments = [];
  var bufferType = null;
  var buffer = [];

  function flushBuffer() {
    if (buffer.length) {
      segments.push({
        type: bufferType,
        lines: buffer
      });
      buffer = [];
    }
  }

  i = 0;
  j = 0;

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      if (bufferType !== 'common') {
        flushBuffer();
        bufferType = 'common';
      }
      buffer.push(oldLines[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (bufferType !== 'removed') {
        flushBuffer();
        bufferType = 'removed';
      }
      buffer.push(oldLines[i]);
      i++;
    } else {
      if (bufferType !== 'added') {
        flushBuffer();
        bufferType = 'added';
      }
      buffer.push(newLines[j]);
      j++;
    }
  }

  flushBuffer();

  while (i < m) {
    if (bufferType !== 'removed') {
      flushBuffer();
      bufferType = 'removed';
    }
    buffer.push(oldLines[i]);
    i++;
  }

  while (j < n) {
    if (bufferType !== 'added') {
      flushBuffer();
      bufferType = 'added';
    }
    buffer.push(newLines[j]);
    j++;
  }

  flushBuffer();

  return segments;
}

function groupDiffBlocks(segments, contextSize) {
  var blocks = [];
  var lastCommon = [];
  var currentBlock = null;

  segments.forEach(function (segment) {
    if (segment.type === 'common') {
      lastCommon = segment.lines;
      if (currentBlock) {
        currentBlock.after = segment.lines.slice(0, contextSize);
        blocks.push(currentBlock);
        currentBlock = null;
      }
      return;
    }

    if (!currentBlock) {
      currentBlock = {
        before: lastCommon.slice(Math.max(0, lastCommon.length - contextSize)),
        changes: []
      };
    }

    currentBlock.changes.push(segment);
  });

  if (currentBlock) {
    currentBlock.after = [];
    blocks.push(currentBlock);
  }

  return blocks;
}

function formatDiffBlocks(blocks, maxLines) {
  if (!blocks.length) {
    return '';
  }

  var output = [];

  blocks.forEach(function (block, index) {
    if (index > 0) {
      output.push('---');
    }

    (block.before || []).forEach(function (line) {
      output.push('  ' + line);
    });

    block.changes.forEach(function (change) {
      var prefix = change.type === 'added' ? '+ ' : '- ';
      change.lines.forEach(function (line) {
        output.push(prefix + line);
      });
    });

    (block.after || []).forEach(function (line) {
      output.push('  ' + line);
    });
  });

  var truncated = false;
  if (output.length > maxLines) {
    output = output.slice(0, maxLines);
    truncated = true;
  }

  if (truncated) {
    output.push('... (değişiklikler kısaltıldı)');
  }

  return output.join('\n');
}

function fallbackDiff(content) {
  if (!content) {
    return 'Değişiklik algılandı fakat içerik çıkarılamadı.';
  }

  var trimmed = content.substring(0, 600);
  if (content.length > 600) {
    trimmed += '\n... (özet)';
  }

  return trimmed;
}

function sendChangeEmail(site, diffSnippet, statusCode) {
  var timestamp = Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyy-MM-dd HH:mm:ss');
  var lines = [
    'Web sayfasında değişiklik tespit edildi.',
    '',
    'Site adı: ' + site.name,
    'URL: ' + site.url,
    'HTTP durum kodu: ' + statusCode,
    'Kontrol zamanı: ' + timestamp,
    '',
    'Değişiklik özeti:',
    diffSnippet
  ];

  MailApp.sendEmail({
    to: CONFIG.notificationEmail,
    subject: 'Web Sayfası Değişikliği: ' + site.name,
    body: lines.join('\n')
  });
}

function buildStorageKey(siteName) {
  return CONFIG.storagePrefix + siteName.replace(/\s+/g, '_');
}

function loadContent(properties, key) {
  var stored = properties.getProperty(key);
  if (!stored) {
    return '';
  }

  try {
    return decompress(stored);
  } catch (error) {
    Logger.log('Depolanan içerik çözülemedi (' + key + '): ' + error.message);
    return '';
  }
}

function saveContent(properties, key, content) {
  if (!content) {
    properties.deleteProperty(key);
    return;
  }

  var compressed = compress(content);
  properties.setProperty(key, compressed);
}

function compress(text) {
  var blob = Utilities.gzip(text || '');
  return Utilities.base64Encode(blob.getBytes());
}

function decompress(base64Text) {
  var bytes = Utilities.base64Decode(base64Text);
  var blob = Utilities.newBlob(bytes);
  return Utilities.ungzip(blob).getDataAsString();
}

function scheduleDailyCheck() {
  ScriptApp.newTrigger('checkWebsites')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .inTimezone(CONFIG.timeZone)
    .create();
}
