/*
 * This Azure Function is responsible for processing information related to an
 * incrementals release and bouncing the artifacts into Artifactory
 */

const fs    = require('fs');
const fetch = require('node-fetch');
const os    = require('os');
const path  = require('path');
const util  = require('util');

const github      = require('./lib/github');
const pipeline    = require('./lib/pipeline');
const permissions = require('./lib/permissions');

const JENKINS_HOST     = process.env.JENKINS_HOST || 'https://ci.jenkins.io';
const INCREMENTAL_URL  = process.env.INCREMENTAL_URL || 'https://repo.jenkins-ci.org/incrementals/'
const ARTIFACTORY_KEY  = process.env.ARTIFACTORY_KEY || 'invalid-key';

const TEMP_ARCHIVE_DIR = path.join(os.tmpdir(), 'incrementals-');
const mktemp           = util.promisify(fs.mkdtemp);

/*
 * Small helper function to make failing a request more concise
 */
const failRequest = (context, body) => {
  context.res = {
    status: 500,
    body: body || 'Unknown error'
  };
};


module.exports = async (context, data) => {
  const buildUrl = data.body.build_url;
  /* If we haven't received any valid data, just bail early
   */
  if (!buildUrl) {
    context.res = {
      status: 400,
      body: 'The incrementals-publisher invocation was missing the build_url attribute'
    };
    return;
  }
  if (!buildUrl.startsWith(JENKINS_HOST)) {
    context.log.error('Misplaced build_url', buildUrl, JENKINS_HOST);
    return failRequest(context, 'This build_url is not supported');
  }
  // Starting some async operations early which we will need later
  let tmpDir = mktemp(TEMP_ARCHIVE_DIR);
  let perms = permissions.fetch();

  /*
   * The first step is to take the buildUrl and fetch some metadata about this
   * specific Pipeline Run
   */
  let buildMetadata = await fetch(process.env.BUILD_METADATA_URL || pipeline.getBuildApiUrl(buildUrl));

  if (buildMetadata.status !== 200) {
    context.log.error('Failed to fetch Pipeline build metadata', buildMetadata);
  }
  let buildMetadataJSON = await buildMetadata.json();

  if (!buildMetadataJSON) {
    context.log.error('I was unable to parse any build JSON metadata', buildMetadata);
    return failRequest(context);
  }
  let buildMetadataParsed = pipeline.processBuildMetadata(buildMetadataJSON);

  if (!buildMetadataParsed.hash) {
    context.log.error('Unable to retrieve a hash or pullHash', buildMetadataJSON);
    return failRequest(context, 'Unable to retrieve a hash or pullHash');
  }

  let folderMetadata = await fetch(process.env.FOLDER_METADATA_URL || pipeline.getFolderApiUrl(buildUrl));
  if (folderMetadata.status !== 200) {
    context.log.error('Failed to fetch Pipeline folder metadata', folderMetadata);
  }
  let folderMetadataJSON = await folderMetadata.json();
  if (!folderMetadataJSON) {
    context.log.error('I was unable to parse any folder JSON metadata', folderMetadata);
    return failRequest(context);
  }
  let folderMetadataParsed = pipeline.processFolderMetadata(folderMetadataJSON);
  if (!folderMetadataParsed.owner || !folderMetadataParsed.repo) {
    context.log.error('Unable to retrieve an owner or repo', folderMetadataJSON);
    return failRequest(context, 'Unable to retrieve an owner or repo');
  }

  if (!github.commitExists(folderMetadataParsed.owner, folderMetadataParsed.repo, buildMetadataParsed.hash)) {
    context.log.error('This request was using a commit which does not exist, or was ambiguous, on GitHub!', buildMetadataParsed.hash);
    return failRequest(context, 'Could not find commit (non-existent or ambiguous)');
  }
  context.log.info('Metadata loaded', folderMetadataParsed.owner, folderMetadataParsed.repo, buildMetadataParsed.hash);

  /*
   * Once we have some data about the Pipeline, we can fetch the actual
   * `archive.zip` which has all the right data within it
   */
  let archiveUrl = process.env.ARCHIVE_URL || pipeline.getArchiveUrl(buildUrl, buildMetadataParsed.hash);

  tmpDir = await tmpDir;
  context.log.info('Prepared a temp dir for the archive', tmpDir);
  const archivePath = path.join(tmpDir, 'archive.zip');

  let done = false;
  await fetch(archiveUrl)
    .then((res) => {
      context.log.info('Response headers', res.headers);
      res.body.pipe(fs.createWriteStream(archivePath)).on('close', () => done = true);
    })
    .catch(err => context.log.error(err));
  function sleep(ms){
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
  };
  while (!done) {
    context.log.info('Downloading…');
    await sleep(1000);
  }
  context.log.info('Downloaded', archiveUrl, archivePath);


  /*
   * Once we have an archive.zip, we need to check our permissions based off of
   * the repository-permissions-updater results
   */
  perms = await perms;
  if (perms.status !== 200) {
    context.log.error('Failed to get our permissions', perms);
    return failRequest(context, 'Failed to retrieve permissions');
  }
  const repoPath = util.format('%s/%s', folderMetadataParsed.owner, folderMetadataParsed.repo);
  let entries = [];
  context.log.info('Downloaded file size', fs.statSync(archivePath).size);
  const verified = await permissions.verify(repoPath, archivePath, entries, perms);
  context.log.info('Archive entries', entries);

  /*
   * Finally, we can upload to Artifactory
   */

  const upload = await fetch(util.format('%sarchive.zip', INCREMENTAL_URL),
    {
      headers: {
        'X-Explode-Archive' : true,
        'X-Explode-Archive-Atomic' : true,
        'X-JFrog-Art-Api' : ARTIFACTORY_KEY,
      },
      method: 'PUT',
      body: fs.createReadStream(archivePath)
  });
  context.log.info('Upload status', upload.status, await upload.text());

  context.res = {
    status: upload.status,
    body: 'Response from Artifactory: ' + upload.statusText + '\n'
  };
};
