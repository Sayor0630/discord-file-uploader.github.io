const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { Client } = require('discord.js');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const expressWs = require('express-ws');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const os = require('os');
require('dotenv').config();
const discordBotToken = process.env.DISCORD_BOT_TOKEN;
const discordChannelId = process.env.DISCORD_CHANNEL_ID;


const PORT = process.env.PORT || 3000;

const app = express();
expressWs(app);

app.use(cors());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const client = new Client({
  intents: ['GUILDS', 'GUILD_MESSAGES'],
});

client.login(discordBotToken);

// WebSocket connections
const wsClients = [];

app.ws('/upload-progress', (ws, req) => {
  // Handle WebSocket connections here
  wsClients.push(ws);

  ws.on('message', (msg) => {
    // Handle messages from the client if needed
  });

  ws.on('close', () => {
    // Handle WebSocket connection close if needed
    const index = wsClients.indexOf(ws);
    if (index !== -1) {
      wsClients.splice(index, 1);
    }
  });
});

// Upload route for folders


app.post('/upload-folder', upload.array('files'), async (req, res) => {
  function extractOriginalFolderName(path) {
    const parts = path.split('.');
    // Remove file extension
    parts.pop();
    // Extract last folder name
    return parts.pop();
  }

  try {
    const files = req.files;

    // Extract the original folder name from the first file's original path
    const originalFolderPath = path.dirname(files[0].originalname);
    // Extract original folder name from the first file's original path
    const originalFolderName = extractOriginalFolderName(files[0].originalname);

    // Use the system's temporary directory to save the zip file
    const tempDir = os.tmpdir();

    // Create a unique ID for the zip file
    const zipFileId = crypto.randomBytes(8).toString('hex');
    // Use original folder name as the zip file name
    const zipFileName = `${originalFolderName}.zip`; // Updated line
    const zipFilePath = path.join(tempDir, zipFileName);

    // Create a write stream for the zip file
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Compression level
    });

    // Pipe the archive to the output stream
    archive.pipe(output);

    // Add each file to the zip archive with its original path
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const originalFileName = file.originalname;

      // Calculate the relative path within the original folder
      const relativePath = path.relative(originalFolderPath, originalFileName);

      // Append the file to the archive with its relative path
      archive.append(file.buffer, { name: originalFileName });
    }

    // Finalize the archive and close the write stream
    await archive.finalize();
    await new Promise(resolve => output.on('close', resolve)); // Wait for the stream to close

    // Read the zip file as a buffer
    const zipBuffer = fs.readFileSync(zipFilePath);

    // Delete the temporary zip file
    // Delete the temporary zip file asynchronously
fs.unlink(zipFilePath, (err) => {
  if (err) {
    console.error('Error deleting temporary zip file:', err);
  } else {
    console.log('Temporary zip file deleted successfully');
  }
});


    // Pass the WebSocket connection to the uploadToDiscord function
    const fileId = crypto.randomBytes(16).toString('hex');
    const chunks = splitFile(fileId, zipBuffer, 'zip', zipFileName);

    const startTime = Date.now(); // Record the start time

    await uploadToDiscord(chunks, wsClients);

    const endTime = Date.now();
    const uploadTime = endTime - startTime;
    res.json({
      fileId,
      zipFileName,
      uploadTime,
      message: 'Folder uploaded successfully',
      /* other data */
    });

  } catch (error) {
    console.error('Error processing folder upload:', error);
    res.status(500).send(`Error processing folder upload: ${error.message}`);
  }
});







app.post('/upload', upload.single('file'), async (req, res) => {
  const startTime = Date.now(); // Record the start time

  const fileBuffer = req.file.buffer;
  const fileId = crypto.randomBytes(16).toString('hex');
  const originalFileName = req.file.originalname;
  const fileExtension = originalFileName.split('.').pop();
  const chunks = splitFile(fileId, fileBuffer, fileExtension, originalFileName);

  // Pass the WebSocket connection to the uploadToDiscord function
  await uploadToDiscord(chunks, wsClients);

  const endTime = Date.now();
  const uploadTime = endTime - startTime;

  res.send({ originalFileName, uploadTime });
});


app.get('/list-files', (req, res) => {
  console.log('Endpoint /list-files called');
  const { sortBy, sortOrder } = req.query;
  listFilesInDiscord(client, res, sortBy, sortOrder);
});

async function listFilesInDiscord(client, res, sortBy, sortOrder) {
  try {
    const channel = await client.channels.fetch(discordChannelId); // Replace with your channel ID
    const messages = await channel.messages.fetch();

    const filesMap = new Map(); // Use a map to group files by fileId
    const processedFileIds = new Set(); // To track processed fileIds

    for (const message of messages.values()) {
      const attachments = message.attachments;
      for (const [, attachment] of attachments) {
        const metadata = JSON.parse(message.content.split('Metadata: ')[1]);
        const fileId = metadata.fileId;

        if (!processedFileIds.has(fileId)) {
          processedFileIds.add(fileId);

          if (!filesMap.has(fileId)) {
            filesMap.set(fileId, {
              fileId,
              originalFileName: metadata.originalFileName,
              totalChunks: metadata.totalChunks,
              currentChunks: metadata.currentChunk,
              dateUploaded: metadata.dateUploaded,
              dateLastUpload: metadata.dateLastUpload,
            });
          }
        }
      }
    }

    const filesList = Array.from(filesMap.values());
    console.log(`Number of files found: ${filesList.length}`);

    // Apply sorting based on sortBy and sortOrder
    filesList.sort((a, b) => {
      if (sortBy === 'name') {
        const nameA = a.originalFileName.toUpperCase();
        const nameB = b.originalFileName.toUpperCase();
        return sortOrder === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
      } else if (sortBy === 'dateUploaded') {
        return sortOrder === 'asc' ? a.dateUploaded - b.dateUploaded : b.dateUploaded - a.dateUploaded;
      } else if (sortBy === 'dateLastUpload') {
        return sortOrder === 'asc' ? a.dateLastUpload - b.dateLastUpload : b.dateLastUpload - a.dateLastUpload;
      }
      return 0;
    });

    res.json({ filesList });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}


app.get('/search-files', (req, res) => {
  console.log('Endpoint /search-files called');
  const { searchInput } = req.query;
  searchFilesInDiscord(client, res, searchInput);
});

async function searchFilesInDiscord(client, res, searchInput) {
  try {
    const channel = await client.channels.fetch(discordChannelId); // Replace with your channel ID
    const messages = await channel.messages.fetch();

    const filesMap = new Map(); // Use a map to group files by fileId
    for (const message of messages.values()) {
      const attachments = message.attachments;
      for (const [, attachment] of attachments) {
        const metadata = JSON.parse(message.content.split('Metadata: ')[1]);
        const fileId = metadata.fileId;

        if (!filesMap.has(fileId)) {
          filesMap.set(fileId, {
            fileId,
            originalFileName: metadata.originalFileName,
            totalChunks: metadata.totalChunks,
            currentChunks: metadata.currentChunk,
            dateUploaded: metadata.dateUploaded,
            dateLastUpload: metadata.dateLastUpload,
          });
        }
      }
    }

    const filesList = Array.from(filesMap.values());

    // Filter files based on search input
    const filteredFiles = filesList.filter((file) =>
      file.fileId.toLowerCase().includes(searchInput) ||
      file.originalFileName.toLowerCase().includes(searchInput)
    );

    res.json({ filesList: filteredFiles });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}








app.get('/download/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  downloadFromDiscord(client, fileId, res);
});

function splitFile(fileId, data, fileExtension, originalFileName) {
  const chunkSize = 25 * 1024 * 1024;
  const chunks = [];

  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = Buffer.from(data.slice(offset, offset + chunkSize));
    chunks.push({ fileId, chunk, fileExtension, originalFileName });
  }

  return chunks;
}

app.delete('/delete/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  deleteFilesInDiscord(client, fileId, res);
});

async function deleteFilesInDiscord(client, fileId, res) {
  try {
    const channel = await client.channels.fetch(discordChannelId); // Replace with your channel ID
    const messages = await channel.messages.fetch();

    // Filter messages that match the provided fileId
    const messagesToDelete = messages.filter((message) => {
      const attachments = message.attachments;
      for (const [, attachment] of attachments) {
        const metadata = JSON.parse(message.content.split('Metadata: ')[1]);
        return metadata.fileId === fileId;
      }
      return false;
    });

    // Extract the originalFileName from the first message in the filtered list
    const originalFileName = messagesToDelete.size > 0 ?
      JSON.parse(messagesToDelete.first().content.split('Metadata: ')[1]).originalFileName :
      'unknown';

    // Delete all messages in the filtered list
    const deletePromises = messagesToDelete.map((message) => message.delete());
    await Promise.all(deletePromises);

    console.log(`Files with ID ${fileId} (${originalFileName}) deleted successfully.`);
    
    // Send the originalFileName in the response
    res.json({
      originalFileName,
    });
  } catch (error) {
    console.error('Error deleting files:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}




async function uploadToDiscord(chunks, wsClients) {
  const channel = await client.channels.fetch(discordChannelId); // Replace with your channel ID
  const startTime = Date.now();
  const totalSize = chunks.reduce((total, chunk) => total + chunk.chunk.length, 0);
  let uploadedSize = 0;
  let averageUploadSpeed = 0;

  const updateInterval = setInterval(() => {
    const currentTime = Date.now();
    const elapsedTime = (currentTime - startTime) / 1000; // in seconds
    const uploadSpeed = uploadedSize / elapsedTime; // Speed in bytes per second
    const uploadSpeedKBps = uploadSpeed / 1024; // Speed in KB per second
    const progress = (uploadedSize / totalSize) * 100;
    const remainingTime = (totalSize - uploadedSize) / uploadSpeed; // in seconds

    const progressData = {
      fileId: chunks[0].fileId, // Using fileId from the first chunk, assuming all chunks have the same fileId
      progress,
      remainingTime: remainingTime.toFixed(2),
      uploadSpeed: uploadSpeedKBps.toFixed(2),
    };

    wsClients.forEach((client) => client.send(JSON.stringify(progressData)));
  }, 1000); // Update every second

  // Process chunks
  for (let i = 0; i < chunks.length; i++) {
    const { fileId, chunk, fileExtension, originalFileName } = chunks[i];

    // Upload each chunk to Discord with the fileId, chunkNumber, and file extension
    await channel.send({
      files: [{ attachment: chunk, name: `${fileId}_${i}.bin` }],
      content: `Metadata: ${JSON.stringify({
        originalFileName,
        fileId,
        fileExtension,
        currentChunk: i + 1,
        totalChunks: chunks.length,
        dateUploaded: Date.now(),
        dateLastUpload: Date.now(),
      })}`,
    });

    uploadedSize += chunk.length;

    // Sleep for 1 second before processing the next chunk (adjust as needed)
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  const finalProgressData = {
    fileId: chunks[0].fileId,
    progress: 100,
    remainingTime: 0,
    uploadSpeed: 0,
  };
  
  wsClients.forEach((client) => client.send(JSON.stringify(finalProgressData)));
  clearInterval(updateInterval);
}



async function downloadFromDiscord(client, fileId, res) {
  try {
    const channel = await client.channels.fetch(discordChannelId); // Replace with your channel ID
    const messages = await channel.messages.fetch();


    const matchingFiles = [];
    for (const message of messages.values()) {
      const attachments = message.attachments;
      for (const [, attachment] of attachments) {
        if (attachment.name.startsWith(`${fileId}_`)) {
          // Extract fileId and fileExtension from metadata in the message content
          const metadata = JSON.parse(message.content.split('Metadata: ')[1]);
          if (metadata.fileId === fileId) {
            console.log('Downloading file from:', attachment.url);
            const fileData = await fetch(attachment.url);
            const buffer = Buffer.from(await fileData.buffer());
            matchingFiles.push({ buffer, originalFileName: metadata.originalFileName, fileId: metadata.fileId, fileExtension: metadata.fileExtension, chunkNumber: parseInt(attachment.name.split('_')[1]) });
          }
        }
      }
    }

    // Sort matchingFiles based on chunkNumber
    matchingFiles.sort((a, b) => a.chunkNumber - b.chunkNumber);

    if (matchingFiles.length === 0) {
      console.log('File not found');
      return res.status(404).json({ error: 'File not found.' });
    }

    console.log('Combining buffers');
    const combinedBuffer = Buffer.concat(matchingFiles.map((file) => file.buffer));
    const fileExtension = matchingFiles[0].fileExtension;
    const originalFileName = matchingFiles[0].originalFileName;

    // Set appropriate headers for browser download
    res.setHeader('Content-Type', `application/${fileExtension}`);
    res.setHeader('Content-Disposition', `attachment; filename="${originalFileName}"`);
    res.send(combinedBuffer);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}


// Start the Express server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  console.log('Discord bot is ready!');
});