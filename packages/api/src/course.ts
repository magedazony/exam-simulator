// Recorded course: the learner's outline, lessons (video and slides),
// progress, the completion certificate and its public check, and the
// administrator's course editor.
//
// Video providers:
//   youtube  an unlisted YouTube video, shown with the privacy-enhanced player.
//            Anyone with the link can watch it, so use it for free lessons or
//            when protection does not matter.
//   bunny    a Bunny Stream video; the player address is signed and expires,
//            so it works only from the app. Needs BUNNY_LIBRARY_ID and
//            BUNNY_TOKEN_KEY.
//   url      a direct video file address (MP4) on any host.
//   none     slides or text only.

import { createHash, randomBytes } from 'node:crypto';
import type { ApiStore } from './api-store.ts';
import { HttpError, invalid, invalidMany, notFound } from './http.ts';
import type { Handler, RouteOptions } from './http.ts';
import type { FieldError } from './admin.ts';

interface CourseDeps {
  store: ApiStore;
  now: () => string;
  access: (userId: string, roles: string[]) => Promise<{ course: boolean }>;
  bunny?: { libraryId: string; tokenKey: string };
  publicUrl: string;
}
interface CourseRoute { method: string; path: string; handler: Handler; options: RouteOptions }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: string | undefined): string => {
  if (!v || !UUID.test(v)) throw notFound();
  return v;
};
const MAX_SLIDES_BYTES = 20 * 1024 * 1024;

/** A YouTube video id from an id or any usual YouTube address, or null. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return /^\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[1] ?? null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      return /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[1] ?? null;
    }
  } catch { /* not a URL */ }
  return null;
}

/** Bunny Stream embed address signed for a few hours (embed view token authentication). */
export function bunnyEmbedUrl(libraryId: string, tokenKey: string, videoId: string, nowMs: number, ttlSeconds = 4 * 3600): string {
  const expires = Math.floor(nowMs / 1000) + ttlSeconds;
  const token = createHash('sha256').update(tokenKey + videoId + expires).digest('hex');
  return `https://iframe.mediadelivery.net/embed/${encodeURIComponent(libraryId)}/${encodeURIComponent(videoId)}?token=${token}&expires=${expires}&autoplay=false&preload=true`;
}

export function courseRoutes({ store, now, access, bunny, publicUrl }: CourseDeps): CourseRoute[] {
  const routes: CourseRoute[] = [];
  const add = (method: string, path: string, handler: Handler, options: RouteOptions = {}) => routes.push({ method, path, handler, options });
  const admins = ['administrator'];

  // ------------------------------------------------------------ learner

  add('GET', '/course', async (c) => {
    const outline = await store.courseOutline(c.claims.sub, now());
    const a = await access(c.claims.sub, c.roles);
    if (a.course && !outline.access) {
      // Staff see the whole course.
      outline.access = true;
      for (const m of outline.modules) for (const l of m.lessons) l.locked = false;
    }
    return { status: 200, body: outline };
  });

  const lessonFor = async (lessonId: string, userId: string, roles: string[]) => {
    const lesson = await store.courseLesson(id(lessonId), userId);
    if (!lesson) throw notFound();
    if (!lesson.isFree && !(await access(userId, roles)).course) {
      throw new HttpError(402, 'course_locked', 'This lesson is part of the recorded course. Get the course to watch it');
    }
    return lesson;
  };

  add('GET', '/course/lessons/:lessonId', async (c) => {
    const l = await lessonFor(c.params.lessonId!, c.claims.sub, c.roles);
    let playback: Record<string, unknown> = { kind: 'none' };
    if (l.videoProvider === 'youtube' && youtubeId(l.videoRef)) {
      playback = { kind: 'youtube', videoId: youtubeId(l.videoRef), embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId(l.videoRef)}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1` };
    } else if (l.videoProvider === 'bunny') {
      playback = bunny && bunny.libraryId && bunny.tokenKey
        ? { kind: 'bunny', embedUrl: bunnyEmbedUrl(bunny.libraryId, bunny.tokenKey, l.videoRef, Date.parse(now())) }
        : { kind: 'unavailable', reason: 'Protected video hosting is not set up on the server yet' };
    } else if (l.videoProvider === 'url' && /^https:\/\//.test(l.videoRef)) {
      playback = { kind: 'file', src: l.videoRef };
    }
    // Previous and next lessons in course order.
    const outline = await store.courseOutline(c.claims.sub, now());
    const order: Array<{ id: string; title: string; titleAr: string }> = outline.modules.flatMap((m: any) => m.lessons);
    const i = order.findIndex((x) => x.id === l.id);
    const { videoRef: _ref, slidesFile: _file, ...rest } = l;
    return {
      status: 200,
      body: {
        ...rest,
        playback,
        previous: i > 0 ? { id: order[i - 1]!.id, title: order[i - 1]!.title, titleAr: order[i - 1]!.titleAr } : null,
        next: i >= 0 && i < order.length - 1 ? { id: order[i + 1]!.id, title: order[i + 1]!.title, titleAr: order[i + 1]!.titleAr } : null,
      },
    };
  });

  add('PUT', '/course/lessons/:lessonId/progress', async (c) => {
    await lessonFor(c.params.lessonId!, c.claims.sub, c.roles);
    const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
    const out = await store.saveLessonProgress(c.claims.sub, c.params.lessonId!, num(c.body.positionSeconds, 36000), num(c.body.addSeconds, 120), c.body.complete === true);
    return { status: 200, body: out };
  });

  add('GET', '/course/lessons/:lessonId/slides', async (c) => {
    await lessonFor(c.params.lessonId!, c.claims.sub, c.roles);
    const f = await store.lessonSlides(c.params.lessonId!);
    if (!f) throw notFound();
    return {
      status: 200,
      raw: {
        bytes: Buffer.from(f.base64, 'base64'),
        contentType: 'application/pdf',
        headers: { 'Content-Disposition': `inline; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`, 'Cache-Control': 'private, no-store' },
      },
    };
  });

  add('POST', '/course/certificate', async (c) => {
    const name = typeof c.body.fullName === 'string' ? c.body.fullName.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 3 || name.length > 120) throw invalid('fullName', 'write your full name as it should appear, 3 to 120 characters');
    try {
      const cert = await store.issueCourseCertificate(c.claims.sub, name, randomBytes(16).toString('hex'));
      return { status: 201, body: { ...cert, verifyUrl: `${publicUrl.replace(/\/$/, '')}/app#course-cert/${String(cert.token)}` } };
    } catch (e) {
      if (String(e).includes('E_NOT_COMPLETE')) throw new HttpError(409, 'course_not_complete', 'Finish every lesson to get the certificate');
      throw e;
    }
  });

  add('GET', '/course-certificates/:token', async (c) => {
    const token = c.params.token ?? '';
    if (!/^[0-9a-f]{32}$/.test(token)) throw notFound();
    const cert = await store.courseCertificateByToken(token);
    if (!cert) throw notFound();
    return { status: 200, body: cert };
  }, { auth: false, limited: true });

  // ------------------------------------------------------------ administrator

  const text = (v: unknown, field: string, min: number, max: number, errors: FieldError[]): string => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s.length < min || s.length > max) errors.push({ field, message: min > 0 ? `must be text of ${min} to ${max} characters` : `must be at most ${max} characters` });
    return s;
  };

  add('GET', '/admin/course', async () => ({ status: 200, body: { modules: await store.adminCourse() } }), { staff: admins });

  const moduleDoc = (b: Record<string, unknown>) => {
    const errors: FieldError[] = [];
    const d = {
      title: text(b.title, 'title', 2, 200, errors),
      titleAr: text(b.titleAr ?? '', 'titleAr', 0, 200, errors),
      summary: text(b.summary ?? '', 'summary', 0, 4000, errors),
      summaryAr: text(b.summaryAr ?? '', 'summaryAr', 0, 4000, errors),
      ordinal: Number.isInteger(b.ordinal) ? (b.ordinal as number) : 0,
      status: b.status === 'published' ? 'published' : 'draft',
    };
    if (errors.length) throw invalidMany(errors);
    return d;
  };
  add('POST', '/admin/course/modules', async (c) => ({ status: 201, body: { id: await store.saveCourseModule(null, moduleDoc(c.body)) } }), { staff: admins });
  add('PUT', '/admin/course/modules/:moduleId', async (c) => {
    const out = await store.saveCourseModule(id(c.params.moduleId), moduleDoc(c.body));
    if (!out) throw notFound();
    return { status: 200, body: { id: out } };
  }, { staff: admins });
  add('DELETE', '/admin/course/modules/:moduleId', async (c) => {
    if (!await store.deleteCourseModule(id(c.params.moduleId))) throw new HttpError(409, 'module_not_empty', 'Move or delete the lessons of this module first');
    return { status: 204 };
  }, { staff: admins });

  const lessonDoc = (b: Record<string, unknown>) => {
    const errors: FieldError[] = [];
    const provider = typeof b.videoProvider === 'string' && ['youtube', 'bunny', 'url', 'none'].includes(b.videoProvider) ? b.videoProvider : 'none';
    let ref = typeof b.videoRef === 'string' ? b.videoRef.trim() : '';
    if (provider === 'youtube') {
      const y = youtubeId(ref);
      if (!y) errors.push({ field: 'videoRef', message: 'must be a YouTube link or video id' });
      else ref = y;
    } else if (provider === 'bunny') {
      if (!/^[0-9a-f-]{36}$/i.test(ref)) errors.push({ field: 'videoRef', message: 'must be the Bunny Stream video id' });
    } else if (provider === 'url') {
      if (!/^https:\/\/\S{4,1000}$/.test(ref)) errors.push({ field: 'videoRef', message: 'must be an https address of a video file' });
    } else ref = '';
    const duration = b.durationSeconds;
    if (provider !== 'none' && (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 10 || duration > 36000)) {
      errors.push({ field: 'durationSeconds', message: 'enter the video length (10 seconds to 10 hours)' });
    }
    const tasks = Array.isArray(b.taskCodes) ? (b.taskCodes as unknown[]).filter((t): t is string => typeof t === 'string' && /^(PEOPLE|PROCESS|BUSINESS)-\d{1,2}$/.test(t)) : [];
    const slidesUrl = typeof b.slidesUrl === 'string' ? b.slidesUrl.trim() : '';
    if (slidesUrl && !/^https:\/\/\S{4,1000}$/.test(slidesUrl)) errors.push({ field: 'slidesUrl', message: 'must be an https address' });
    if (typeof b.moduleId !== 'string' || !UUID.test(b.moduleId)) errors.push({ field: 'moduleId', message: 'is required' });
    const d = {
      moduleId: b.moduleId as string,
      title: text(b.title, 'title', 2, 200, errors),
      titleAr: text(b.titleAr ?? '', 'titleAr', 0, 200, errors),
      summary: text(b.summary ?? '', 'summary', 0, 8000, errors),
      summaryAr: text(b.summaryAr ?? '', 'summaryAr', 0, 8000, errors),
      videoProvider: provider, videoRef: ref,
      durationSeconds: provider === 'none' ? (Number.isInteger(duration) && (duration as number) >= 0 ? (duration as number) : 0) : (duration as number),
      isFree: b.isFree === true, taskCodes: [...new Set(tasks)].slice(0, 10), slidesUrl,
      ordinal: Number.isInteger(b.ordinal) ? (b.ordinal as number) : 0,
      status: b.status === 'published' ? 'published' : 'draft',
    };
    if (errors.length) throw invalidMany(errors);
    return d;
  };
  add('POST', '/admin/course/lessons', async (c) => ({ status: 201, body: { id: await store.saveCourseLesson(null, lessonDoc(c.body)) } }), { staff: admins });
  add('PUT', '/admin/course/lessons/:lessonId', async (c) => {
    const out = await store.saveCourseLesson(id(c.params.lessonId), lessonDoc(c.body));
    if (!out) throw notFound();
    return { status: 200, body: { id: out } };
  }, { staff: admins });
  add('DELETE', '/admin/course/lessons/:lessonId', async (c) => {
    await store.deleteCourseLesson(id(c.params.lessonId));
    return { status: 204 };
  }, { staff: admins });

  // Slides as a PDF file kept in the database (up to 20 MB).
  add('PUT', '/admin/course/lessons/:lessonId/slides', async (c) => {
    const lessonId = id(c.params.lessonId);
    const filename = typeof c.body.filename === 'string' ? c.body.filename.slice(0, 200) : 'slides.pdf';
    const b64 = typeof c.body.dataBase64 === 'string' ? c.body.dataBase64 : '';
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) throw invalid('dataBase64', 'is required');
    if (bytes.length > MAX_SLIDES_BYTES) throw invalid('dataBase64', 'the file must be at most 20 MB');
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw invalid('dataBase64', 'must be a PDF file');
    await store.setLessonSlides(lessonId, c.claims.sub, filename, bytes.toString('base64'));
    return { status: 204 };
  }, { staff: admins, maxBodyBytes: 28 * 1024 * 1024 });
  add('DELETE', '/admin/course/lessons/:lessonId/slides', async (c) => {
    await store.setLessonSlides(id(c.params.lessonId), c.claims.sub, '', null);
    return { status: 204 };
  }, { staff: admins });

  return routes;
}
