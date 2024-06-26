import { LeetCodeV1, LeetCodeV2 } from './versions';
import setupManualSubmitBtn from './submitBtn';
import {
  debounce,
  delay,
  DIFFICULTY,
  getBrowser,
  isEmpty,
  LeetHubError,
} from './util';
import { appendProblemToReadme, sortTopicsInReadme } from './readmeTopics';

/* Commit messages */
const readmeMsg = 'Create README - LeetHub';
const updateReadmeMsg = 'Update README - Topic Tags';
const updateStatsMsg = 'Updated stats';
const discussionMsg = 'Prepend discussion post - LeetHub';
const createNotesMsg = 'Attach NOTES - LeetHub';
const defaultRepoReadme =
  'A collection of LeetCode questions to ace the coding interview! - Created using [LeetHub v2](https://github.com/arunbhardwaj/LeetHub-2.0)';
const readmeFilename = 'README.md';
const statsFilename = 'stats.json';

// problem types
const NORMAL_PROBLEM = 0;
const EXPLORE_SECTION_PROBLEM = 1;

const WAIT_FOR_GITHUB_API_TO_NOT_THROW_409_MS = 500;

const api = getBrowser();

/**
 * Constructs a file path by appending the given filename to the problem directory.
 * If no filename is provided, it returns the problem name as the path.
 *
 * @param {string} problem - The base problem directory or the entire file path if no filename is provided.
 * @param {string} [filename] - Optional parameter for the filename to be appended to the problem directory.
 * @returns {string} - Returns a string representing the complete file path, either with or without the appended filename.
 */
const getPath = (problem, filename) => {
  return filename ? `${problem}/${filename}` : problem;
};

/**
 * Uploads content to a specified GitHub repository (i.e. hook) and path (i.e. <problem/filename>).
 * @async
 * @param {string} token - The authentication token used to authorize the request.
 * @param {string} hook - The owner and repository name in the format 'owner/repo'.
 * @param {string} content - The content to be uploaded, typically a string encoded in base64.
 * @param {string} problem - The problem slug, which is a combination of problem ID and name, and acts as a folder.
 * @param {string} filename - The name of the file, typically the problem slug + file extension.
 * @param {string} sha - The SHA of the existing file.
 * @param {string} message - A commit message describing the change.
 *
 * @returns {Promise<string>} - A promise that resolves with the new SHA of the content after successful upload.
 *
 * @throws {LeetHubError} - Throws a custom error if the HTTP response is not OK.
 */
const upload = async (token, hook, content, problem, filename, sha, message) => {
  const path = getPath(problem, filename);
  const URL = `https://api.github.com/repos/${hook}/contents/${path}`;

  let data = {
    message,
    content,
    sha,
  };

  data = JSON.stringify(data);

  let options = {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
    body: data,
  };

  const res = await fetch(URL, options);
  if (!res.ok) {
    throw new LeetHubError(res.status, {cause: res});
  }
  console.log(`Successfully committed ${getPath(problem, filename)} to github`);

  const body = await res.json();
  //TODO: pull this out of this function
  const stats = await getAndInitializeStats(problem);
  stats.shas[problem][filename] = body.content.sha;
  api.storage.local.set({ stats });

  return body.content.sha;
};

// Returns stats object. If it didn't exist, initializes stats with default difficulty values and initializes the sha object for problem
const getAndInitializeStats = problem => {
  return api.storage.local.get('stats').then(({ stats }) => {
    if (stats == null || isEmpty(stats)) {
      stats = {};
      stats.shas = {};
      stats.solved = 0;
      stats.easy = 0;
      stats.medium = 0;
      stats.hard = 0;
    }

    if (stats.shas[problem] == null) {
      stats.shas[problem] = {};
    }

    return stats;
  });
};

const incrementStats = (difficulty, problemName) => {
  return api.storage.local
    .get('stats')
    .then(({ stats }) => {
      stats.solved += 1;
      stats.easy += difficulty === DIFFICULTY.EASY ? 1 : 0;
      stats.medium += difficulty === DIFFICULTY.MEDIUM ? 1 : 0;
      stats.hard += difficulty === DIFFICULTY.HARD ? 1 : 0;
      api.storage.local.set({ stats });
      return stats;
    })
    .then(uploadPersistentStats);
  // .catch(console.error)
};

const checkAlreadyCompleted = problemName => {
  return api.storage.local.get('stats').then(({ stats }) => {
    if (stats?.shas?.[problemName] == null) {
      return false;
    }
    return true;
  });
};

/* Discussion posts prepended at top of README */
/* Future implementations may require appending to bottom of file */
const updateReadmeWithDiscussionPost = async (
  addition,
  directory,
  filename,
  commitMsg,
  shouldPreprendDiscussionPosts
) => {
  let responseSHA;
  const { leethub_token, leethub_hook } = await api.storage.local.get([
    'leethub_token',
    'leethub_hook',
  ]);

  return getGitHubFile(leethub_token, leethub_hook, directory, filename)
    .then(resp => resp.json())
    .then(data => {
      responseSHA = data.sha;
      return decodeURIComponent(escape(atob(data.content)));
    })
    .then(existingContent =>
      // https://web.archive.org/web/20190623091645/https://monsur.hossa.in/2012/07/20/utf-8-in-javascript.html
      // In order to preserve mutation of the data, we have to encode it, which is usually done in base64.
      // But btoa only accepts ASCII 7 bit chars (0-127) while Javascript uses 16-bit minimum chars (0-65535).
      // EncodeURIComponent converts the Unicode Points UTF-8 bits to hex UTF-8.
      // Unescape converts percent-encoded hex values into regular ASCII (optional; it shrinks string size).
      // btoa converts ASCII to base64.
      shouldPreprendDiscussionPosts
        ? btoa(unescape(encodeURIComponent(addition + existingContent)))
        : btoa(unescape(encodeURIComponent(existingContent)))
    )
    .then(newContent =>
      upload(leethub_token, leethub_hook, newContent, directory, filename, responseSHA, commitMsg)
    );
};

/**
 * Wrapper func to upload code to a specific GitHub repository and handle 409 errors (conflict)
 * @async
 * @function uploadGitWith409Retry
 * @param {string} code - The code content that needs to be uploaded.
 * @param {string} problemName - The name of the problem or file where the code is related to.
 * @param {string} filename - The target filename in the repository where the code will be stored.
 * @param {string} commitMsg - The commit message that describes the changes being made.
 *
 * @returns {Promise<string>} A promise that resolves with the new SHA of the content after successful upload.
 *
 * @throws {LeetHubError} If there's no token defined, the mode type is not 'commit', or if no repository hook is defined.
 */
async function uploadGitWith409Retry(code, problemName, filename, commitMsg, sha1) {
  let token;
  let hook;

  const storageData = await api.storage.local.get([
    'leethub_token',
    'mode_type',
    'leethub_hook',
    'stats',
  ]);

  token = storageData.leethub_token;
  if (!token) {
    throw new LeetHubError('LeethubTokenUndefined');
  }

  if (storageData.mode_type !== 'commit') {
    throw new LeetHubError('LeetHubNotAuthorizedByGit');
  }

  hook = storageData.leethub_hook;
  if (!hook) {
    throw new LeetHubError('NoRepoDefined');
  }

  /* Get SHA, if it exists */
  const sha = (sha1) ? sha1 :
    storageData.stats?.shas?.[problemName]?.[filename] !== undefined
      ? storageData.stats.shas[problemName][filename]
      : '';

  try {
    return await upload(token, hook, code, problemName, filename, sha, commitMsg);
  } catch (err) {
    if (err.message === '409') {
      const data = await getGitHubFile(token, hook, problemName, filename).then(res => res.json());
      return await upload(token, hook, code, problemName, filename, data.sha, commitMsg);
    }
    throw err;
  }
}

/** Returns GitHub data for the file specified by `${directory}/${filename}` path
 * @async
 * @function getGitHubFile
 * @param {string} token - The personal access token for authentication with GitHub.
 * @param {string} hook - The owner and repository name in the format "owner/repository".
 * @param {string} directory - The directory within the repository where the file is located.
 * @param {string} filename - The name of the file to be fetched.
 * @returns {Promise<Response>} A promise that resolves with the response from the GitHub API request.
 * @throws {Error} Throws an error if the fetch operation fails (e.g., HTTP status code is not 200-299).
 */
async function getGitHubFile(token, hook, directory, filename) {
  const path = getPath(directory, filename);
  const URL = `https://api.github.com/repos/${hook}/contents/${path}`;

  let options = {
    method: 'GET',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  };

  const res = await fetch(URL, options);
  if (!res.ok) {
    throw new Error(res.status);
  }

  return res;
}

// Updates or creates the persistent stats from local stats
async function uploadPersistentStats(localStats) {
  // const { leethub_token, leethub_hook, stats } = await api.storage.local.get([
  //   'leethub_token',
  //   'leethub_hook',
  //   'stats',
  // ]);
  const pStats = { leetcode: localStats };
  const pStatsEncoded = btoa(unescape(encodeURIComponent(JSON.stringify(pStats))));

  // const sha = stats?.shas?.[statsFilename] !== undefined ? stats.shas[statsFilename][''] : '';
  return delay(
    uploadGitWith409Retry,
    WAIT_FOR_GITHUB_API_TO_NOT_THROW_409_MS,
    pStatsEncoded,
    statsFilename,
    '',
    updateStatsMsg
  );
  // return upload(leethub_token, leethub_hook, pStatsEncoded, statsFilename, '', sha, updateStatsMsg)
  // .catch(err => {
  //   if (err.message === '409') {
  //     return getGitHubFile(leethub_token, leethub_hook, statsFilename, '').then(res =>
  //       res.json()
  //     );
  //   }
  //   throw err;
  // })
  // .then(data => {
  //   if (data == null) {
  //     throw new LeetHubError('Unknown error updating persistent stats');
  //   }
  //   return decodeURIComponent(escape(atob(data.content)));
  // })
  // .then(content => JSON.parse(content))
  // .then(data => data?.leetcode)
  // .then(async pStats => {
  //   if (pStats.solved > stats.solved) {
  //     stats = pStats;
  //   }
  // });
}

/* Discussion Link - When a user makes a new post, the link is prepended to the README for that problem.*/
document.addEventListener('click', event => {
  const element = event.target;
  const oldPath = window.location.pathname;

  /* Act on Post button click */
  /* Complex since "New" button shares many of the same properties as "Post button */
  if (
    element &&
    (element.classList.contains('icon__3Su4') ||
      element.parentElement?.classList.contains('icon__3Su4') ||
      element.parentElement?.classList.contains('btn-content-container__214G') ||
      element.parentElement?.classList.contains('header-right__2UzF'))
  ) {
    setTimeout(function () {
      /* Only post if post button was clicked and url changed */
      if (
        oldPath !== window.location.pathname &&
        oldPath === window.location.pathname.substring(0, oldPath.length) &&
        !Number.isNaN(window.location.pathname.charAt(oldPath.length))
      ) {
        const date = new Date();
        const currentDate = `${date.getDate()}/${date.getMonth()}/${date.getFullYear()} at ${date.getHours()}:${date.getMinutes()}`;
        const addition = `[Discussion Post (created on ${currentDate})](${window.location})  \n`;
        const problemName = window.location.pathname.split('/')[2]; // must be true.
        updateReadmeWithDiscussionPost(addition, problemName, readmeFilename, discussionMsg, true);
      }
    }, 1000);
  }
});

function createRepoReadme() {
  const content = btoa(unescape(encodeURIComponent(defaultRepoReadme)));
  return uploadGitWith409Retry(content, readmeFilename, '', readmeMsg);
}

async function updateReadmeTopicTagsWithProblem(topicTags, problemName) {
  if (topicTags == null) {
    console.log(new LeetHubError('TopicTagsNotFound'));
    return;
  }

  const { leethub_token, leethub_hook, stats } = await api.storage.local.get([
    'leethub_token',
    'leethub_hook',
    'stats',
  ]);
  let readme;
  let newSha;
  try {
    const { content, sha } = await getGitHubFile(
      leethub_token,
      leethub_hook,
      readmeFilename
    ).then(resp => resp.json());
    readme = content;
    stats.shas[readmeFilename] = { '': sha };
    await chrome.storage.local.set({ stats });
  } catch (err) {
    if (err.message === '404') {
      newSha = await createRepoReadme();
    }
    throw err;
  }
  readme = decodeURIComponent(escape(atob(readme)));
  for (let topic of topicTags) {
    readme = appendProblemToReadme(topic.name, readme, leethub_hook, problemName);
  }
  readme = sortTopicsInReadme(readme);
  readme = btoa(unescape(encodeURIComponent(readme)));

  return await new Promise((resolve, reject) =>
    setTimeout(
      () => resolve(uploadGitWith409Retry(readme, readmeFilename, '', updateReadmeMsg, newSha)),
      WAIT_FOR_GITHUB_API_TO_NOT_THROW_409_MS
    )
  );
}

function loader(leetCode) {
  let iterations = 0;
  const intervalId = setInterval(async () => {
    try {
      const isSuccessfulSubmission = leetCode.getSuccessStateAndUpdate();
      if (!isSuccessfulSubmission) {
        iterations++;
        if (iterations > 9) {
          // poll for max 10 attempts (10 seconds)
          throw new LeetHubError('Could not find successful submission after 10 seconds.');
        }
        return;
      }
      leetCode.startSpinner();

      // If successful, stop polling
      clearInterval(intervalId);

      // For v2, query LeetCode API for submission results
      await leetCode.init();

      const probStats = leetCode.parseStats();
      if (!probStats) {
        throw new LeetHubError('SubmissionStatsNotFound');
      }

      const probStatement = leetCode.parseQuestion();
      if (!probStatement) {
        throw new LeetHubError('ProblemStatementNotFound');
      }

      const problemName = leetCode.getProblemNameSlug();
      const alreadyCompleted = await checkAlreadyCompleted(problemName);
      const language = leetCode.getLanguageExtension();
      if (!language) {
        throw new LeetHubError('LanguageNotFound');
      }
      const filename = problemName + language;

      /* Upload README */
      const uploadReadMe = await api.storage.local.get('stats').then(({ stats }) => {
        const shaExists = stats?.shas?.[problemName]?.[readmeFilename] !== undefined;

        if (!shaExists) {
          return uploadGitWith409Retry(
            btoa(unescape(encodeURIComponent(probStatement))),
            problemName,
            readmeFilename,
            readmeMsg
          );
        }
      });

      /* Upload Notes if any*/
      const notes = leetCode.getNotesIfAny();
      let uploadNotes;
      if (notes != undefined && notes.length > 0) {
        uploadNotes = uploadGitWith409Retry(
          btoa(unescape(encodeURIComponent(notes))),
          problemName,
          'NOTES.md',
          createNotesMsg
        );
      }

      /* Upload code to Git */
      const code = leetCode.findCode(probStats);
      const uploadCode = uploadGitWith409Retry(
        btoa(unescape(encodeURIComponent(code))),
        problemName,
        filename,
        probStats
      );

      /* Group problem into its relevant topics */
      const updateRepoReadMe = updateReadmeTopicTagsWithProblem(
        leetCode.submissionData?.question?.topicTags,
        problemName
      );

      const newSHAs = await Promise.all([uploadReadMe, uploadNotes, uploadCode, updateRepoReadMe]);

      leetCode.markUploaded();

      if (!alreadyCompleted) {
        incrementStats(leetCode.difficulty); // Increments local and persistent stats
      }
    } catch (err) {
      leetCode.markUploadFailed();
      clearInterval(intervalId);

      if (!(err instanceof LeetHubError)) {
        console.error(err);
        return;
      }
    }
  }, 1000);
}

// Submit by Keyboard Shortcuts only support on LeetCode v2
function wasSubmittedByKeyboard(event) {
  const isEnterKey = event.key === 'Enter';
  const isMacOS = window.navigator.userAgent.includes('Mac');

  // Adapt to MacOS operating system
  return isEnterKey && ((isMacOS && event.metaKey) || (!isMacOS && event.ctrlKey));
}

// Get SubmissionID by listening for URL changes to `/submissions/(d+)` format
async function listenForSubmissionId() {
  const { submissionId } = await api.runtime.sendMessage({
    type: 'LEETCODE_SUBMISSION',
  });
  if (submissionId == null) {
    console.log(new LeetHubError('SubmissionIdNotFound'));
    return;
  }
  return submissionId;
}

async function v2SubmissionHandler(event, leetCode) {
  if (event.type !== 'click' && !wasSubmittedByKeyboard(event)) {
    return;
  }

  const authenticated =
    !isEmpty(await api.storage.local.get(['leethub_token'])) &&
    !isEmpty(await api.storage.local.get(['leethub_hook']));
  if (!authenticated) {
    throw new LeetHubError('UserNotAuthenticated');
  }

  // is click or is ctrl enter
  const submissionId = await listenForSubmissionId();
  leetCode.submissionId = submissionId;
  loader(leetCode);
  return true;
}

// Use MutationObserver to determine when the submit button elements are loaded
const submitBtnObserver = new MutationObserver(function (_mutations, observer) {
  const v1SubmitBtn = document.querySelector('[data-cy="submit-code-btn"]');
  const v2SubmitBtn = document.querySelector('[data-e2e-locator="console-submit-button"]');
  const textareaList = document.getElementsByTagName('textarea');
  const textarea =
    textareaList.length === 4
      ? textareaList[2]
      : textareaList.length === 2
      ? textareaList[0]
      : textareaList[1];

  if (v1SubmitBtn) {
    observer.disconnect();

    const leetCode = new LeetCodeV1();
    v1SubmitBtn.addEventListener('click', () => loader(leetCode));
    return;
  }

  if (v2SubmitBtn && textarea) {
    observer.disconnect();

    const leetCode = new LeetCodeV2();
    if (!!!v2SubmitBtn.onclick) {
      textarea.addEventListener('keydown', e => v2SubmissionHandler(e, leetCode));
      v2SubmitBtn.onclick = e => v2SubmissionHandler(e, leetCode);
    }
  }
});

submitBtnObserver.observe(document.body, {
  childList: true,
  subtree: true,
});

/* Sync to local storage */
api.storage.local.get('isSync', data => {
  const keys = [
    'leethub_token',
    'leethub_username',
    'pipe_leethub',
    'stats',
    'leethub_hook',
    'mode_type',
  ];
  if (!data || !data.isSync) {
    keys.forEach(key => {
      api.storage.sync.get(key, data => {
        api.storage.local.set({ [key]: data[key] });
      });
    });
    api.storage.local.set({ isSync: true }, () => {
      console.log('LeetHub Synced to local values');
    });
  } else {
    console.log('LeetHub Local storage already synced!');
  }
});

setupManualSubmitBtn(
  debounce(
    () => {
      // Manual submission event doesn't need to wait for submission url. It already has it.
      const leetCode = new LeetCodeV2();
      const submissionId = window.location.href.match(/leetcode\.com\/.*\/submissions\/(\d+)/)[1];
      leetCode.submissionId = submissionId;
      loader(leetCode);
      return;
    },
    5000,
    true
  )
);

class LeetHubNetworkError extends LeetHubError {
  constructor(response) {
    super(response.statusText);
    this.status = response.status;
  }
}
